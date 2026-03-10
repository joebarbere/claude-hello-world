# Project Creation Summary

Steps taken to scaffold, configure, debug, and containerize this Nx Angular micro-frontend monorepo.

---

## Step 1: Scaffold the Nx Workspace

```bash
cd /Users/joe/play
npx create-nx-workspace@latest claude-hello-world --preset=apps --nxCloud=skip --pm=npm
```

Used `--preset=apps` for an empty workspace with no pre-generated apps, and `--pm=npm` to pin the package manager. Nx 22.5.4 was installed. The workspace was created at `/Users/joe/play/claude-hello-world` with git already initialized.

---

## Step 2: Add the Angular Plugin

```bash
cd claude-hello-world
NX_IGNORE_UNSUPPORTED_TS_SETUP=true npx nx add @nx/angular
```

The first attempt without the env var failed:

```
NX  The "@nx/angular" plugin doesn't support the existing TypeScript setup
The Angular framework doesn't support a TypeScript setup with project references.
```

Nx 22 scaffolds workspaces with TypeScript project references enabled (`composite: true` in `tsconfig.base.json`). Angular doesn't support that mode. The env var bypasses the check so the plugin installs anyway — the TS incompatibilities are fixed manually later (Step 9).

---

## Step 3: Generate the Host and Remote Apps

```bash
NX_IGNORE_UNSUPPORTED_TS_SETUP=true npx nx g @nx/angular:host apps/shell \
  --remotes=weather-app,weatheredit-app --standalone --bundler=webpack --no-interactive
```

The `host` generator creates:
- `apps/shell/` — the host (shell) application with `module-federation.config.ts` and webpack configs
- `apps/weather-app/` and `apps/weatheredit-app/` — remote apps each exposing `./Routes`
- Corresponding `-e2e` projects for Playwright tests

The `--standalone` flag uses standalone Angular components (no NgModule). `--bundler=webpack` is required for Module Federation (rspack support is separate).

---

## Step 4: Create the GitHub Repository

Used the `mcp__github__create_repository` MCP tool to create a public repo named `claude-hello-world` under `joebarbere`. HTTPS authentication with a PAT was required since SSH keys were not configured in this environment:

```bash
git remote set-url origin https://joebarbere:${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/joebarbere/claude-hello-world.git
git push -u origin main
```

---

## Step 5: Configure Production Remote URLs in the Shell

Edited `apps/shell/webpack.prod.config.ts` to add production remote URL overrides. Nx generates this file with a placeholder comment. The remotes are served at path-based URLs inside the nginx container:

```ts
// apps/shell/webpack.prod.config.ts
export default withModuleFederation(
  {
    ...config,
    remotes: [
      ['weather-app', '/weather-app/remoteEntry.mjs'],
      ['weatheredit-app', '/weatheredit-app/remoteEntry.mjs'],
    ],
  },
  { dts: false }
);
```

The dev webpack config (`webpack.config.ts`) keeps `remotes: ['weather-app', 'weatheredit-app']` for localhost dev server use.

---

## Step 6: Set baseHref for Remote Apps

Added `"baseHref": "/weather-app/"` and `"baseHref": "/weatheredit-app/"` to the production configuration in each remote's `project.json`. This ensures Angular sets `<base href="/weather-app/">` in the generated HTML so asset paths resolve correctly when served from a sub-path.

---

## Step 7: Create the nginx Configuration

Created `nginx/nginx.conf` with path-based routing:
- `/` → shell app (`/usr/share/nginx/html/shell`)
- `/weather-app/` → weather-app remote (`/usr/share/nginx/html/weather-app/`)
- `/weatheredit-app/` → weatheredit-app remote (`/usr/share/nginx/html/weatheredit-app/`)

Used `try_files $uri $uri/ /index.html` for the shell (SPA fallback) and `try_files $uri /weather-app/index.html` for remotes.

---

## Step 8: Create the Containerfile.nginx and docker-compose.yml

**`Containerfile.nginx`** — multi-stage build:
1. Stage 1 (`builder`): `node:20-alpine`, runs `npm ci` then `npx nx run-many --target=build --projects=shell,weather-app,weatheredit-app --configuration=production --parallel=3`
2. Stage 2 (`runner`): `nginx:alpine`, copies each app's build output to its nginx serving directory

**`docker-compose.yml`** — kept for reference but not used at runtime (see Step 16). Maps host port 8080 to container port 80 and references the pre-built image by name.

---

## Step 9: Add Nx Custom Targets to shell/project.json

Added four targets to `apps/shell/project.json`:

| Target | Command |
|--------|---------|
| `build-all` | `npx nx run-many --target=build --projects=shell,weather-app,weatheredit-app --configuration=production --parallel=3` |
| `podman-build` | `podman build -t claude-hello-world -f Containerfile.nginx .` (depends on `build-all`) |
| `podman-up` | `podman run -d --name claude-hello-world -p 8080:80 localhost/claude-hello-world:latest` |
| `podman-down` | `podman rm -f claude-hello-world` |

---

## Step 10: Initial Commit and Push

```bash
# Commit 1: all scaffolded files
git add --all -- ':!Containerfile.nginx' ':!docker-compose.yml' ':!nginx/'
git commit -m "feat: initial Nx Angular MFE monorepo"

# Commit 2: infra files
git add Containerfile.nginx docker-compose.yml nginx/nginx.conf
git commit -m "feat: add Podman, nginx, and Nx podman targets"

git push -u origin main
```

---

## Step 11: Debug — BUILD-001 (Failed to find expose module)

Running `npx nx podman-build shell` failed with:

```
<e> [EnhancedModuleFederationPlugin] Failed to find expose module. #BUILD-001
<e> args: {"exposeModules":[{"name":"./Routes","module":null,
    "request":"apps/weather-app/src/app/remote-entry/entry.routes.ts"}]}
```

**Diagnosis:** The `exposes` path in `module-federation.config.ts` was `apps/weather-app/src/app/remote-entry/entry.routes.ts` — no leading `./`. Webpack's resolver treats paths without a `./`/`../`/`/` prefix as bare module specifiers (node_modules lookups), not file paths. The `ContainerEntryModule` in `@module-federation/enhanced` has a null context, so webpack uses the compilation context (workspace root) for resolution. Without `./`, the file is never found.

**Debugging steps:**
```bash
# Confirmed file exists at workspace-root-relative path
node -e "
  const path = require('path');
  const fs = require('fs');
  console.log(fs.existsSync(path.resolve(process.cwd(), 'apps/weather-app/src/app/remote-entry/entry.routes.ts')));
"
# => true (file exists, so the problem is how webpack resolves it, not where it is)

# Traced the error source to ContainerEntryModule.js line ~145
grep -n "BUILD-001\|exposeModules" \
  node_modules/@module-federation/enhanced/dist/src/lib/container/ContainerEntryModule.js

# Found: moduleGraph.getModule(dep) returns null when dep can't be resolved
# Confirmed ContainerEntryModule calls super(JAVASCRIPT_MODULE_TYPE_DYNAMIC, null)
# — null context means webpack falls back to compilation.options.context (workspace root)
grep -n "context:" \
  node_modules/@angular-devkit/build-angular/src/tools/webpack/configs/common.js
# => context: root  (root = workspaceRoot)
```

**Fix:** Use `path.join(__dirname, ...)` in the MF config so the path is absolute:

```ts
// apps/weather-app/module-federation.config.ts
import { join } from 'path';
exposes: {
  './Routes': join(__dirname, 'src/app/remote-entry/entry.routes.ts'),
}
```

`__dirname` at Node.js config-evaluation time is `apps/weather-app/`, giving an unambiguous absolute path.

---

## Step 12: Debug — `Cannot find name 'console'` (missing DOM lib)

After fixing BUILD-001, the build failed with:

```
Error: apps/weather-app/src/bootstrap.ts:5:61 - error TS2584:
Cannot find name 'console'. Do you need to change your target library?
Try changing the 'lib' compiler option to include 'dom'.
```

**Diagnosis:** `tsconfig.base.json` was generated with `"lib": ["es2022"]` only. The `dom` lib (which provides `console`, `window`, `document`, etc.) was missing.

**Fix:** Added `"lib": ["es2022", "dom"]` to the `compilerOptions` of every `tsconfig.app.json` (shell, weather-app, weatheredit-app).

---

## Step 13: Debug — Angular Compiler Rejects Project Reference Options

The next build attempt failed with:

```
Error: NG4006: TS compiler option "emitDeclarationOnly" is not supported.
Error: TS5069: Option 'emitDeclarationOnly' cannot be specified without specifying 'declaration' or 'composite'.
Error: TS5090: Non-relative paths are not allowed when 'baseUrl' is not set.
```

**Diagnosis:** `tsconfig.base.json` inherited into `tsconfig.app.json` carries project-reference settings (`composite: true`, `emitDeclarationOnly: true`, `declarationMap: true`) that Angular's compiler explicitly rejects. Additionally, the path aliases (`"weather-app/Routes": [...]`) in `tsconfig.base.json` require a `baseUrl` to resolve, but none was set on the app-level tsconfigs.

**Fix:** Overrode those options in every `tsconfig.app.json`:

```json
"composite": false,
"declarationMap": false,
"emitDeclarationOnly": false,
"baseUrl": "."
```

---

## Step 14: Debug — `Cannot find module 'weather-app/Routes'` in Shell

Shell build failed with:

```
Error: apps/shell/src/app/app.routes.ts:11:32 - error TS2307:
Cannot find module 'weather-app/Routes' or its corresponding type declarations.
```

**Diagnosis:** The shell imports remotes as `import('weather-app/Routes')`. TypeScript resolves this using the `paths` aliases in `tsconfig.base.json`:

```json
"paths": {
  "weather-app/Routes": ["apps/weather-app/src/app/remote-entry/entry.routes.ts"]
}
```

Path aliases are resolved relative to `baseUrl`. With `"baseUrl": "."` (= `apps/shell/`), TypeScript looked for `apps/shell/apps/weather-app/src/...` which doesn't exist. The remote apps (weather-app, weatheredit-app) built fine because they don't use those aliases themselves.

**Fix:** Set `"baseUrl": "../../"` in `apps/shell/tsconfig.app.json` so path resolution starts from the workspace root, where `apps/weather-app/src/...` is valid. Remote apps kept `"baseUrl": "."` .

---

## Step 15: Debug — Containerfile.nginx Copies Wrong Path

With all JS builds passing, `podman build` failed at the COPY stage:

```
Error: COPY --from=builder /app/dist/apps/shell/browser: no such file or directory
```

**Diagnosis:** The plan assumed output at `dist/apps/shell/browser/` (common for `@angular-devkit/build-angular:browser`), but `@nx/angular:webpack-browser` outputs directly to `dist/apps/shell/` with no `browser/` subdirectory.

**Debugging:**
```bash
ls dist/apps/shell/
# => index.html  main.*.js  remoteEntry.mjs  ...  (no browser/ subdir)
```

**Fix:** Removed `/browser` suffix from all three COPY lines in `Containerfile.nginx`:

```dockerfile
COPY --from=builder /app/dist/apps/shell /usr/share/nginx/html/shell
COPY --from=builder /app/dist/apps/weather-app /usr/share/nginx/html/weather-app
COPY --from=builder /app/dist/apps/weatheredit-app /usr/share/nginx/html/weatheredit-app
```

---

## Step 16: Debug — `podman-up` Triggered an Image Rebuild

Running `npx nx podman-up shell` failed with:

```
error listing credentials - err: exec: "docker-credential-osxkeychain":
executable file not found in $PATH
```

**Diagnosis:** The original `docker-compose.yml` had a `build: context/dockerfile` section. `podman compose up` (delegating to Docker Compose v2) saw the build context and attempted to rebuild the image from scratch, which required the `docker-credential-osxkeychain` helper — not present in this environment.

**Fix:** Removed the `build:` block from `docker-compose.yml` and replaced it with `image: localhost/claude-hello-world:latest` so compose uses the image already produced by `podman-build`. Also added `--no-build` to the `podman compose up` command as a safeguard.

---

## Step 17: Debug — Docker Compose v2 Nil Pointer Panic

After the rebuild was suppressed, `podman compose up` still failed:

```
panic: runtime error: invalid memory address or nil pointer dereference
github.com/docker/compose/v2/pkg/compose.(*monitor).Start(...)
  github.com/docker/compose/v2/pkg/compose/monitor.go:150
Error: executing /usr/local/bin/docker-compose up --no-build: exit status 2
```

**Diagnosis:** `podman compose` delegates to `/usr/local/bin/docker-compose` (Docker Compose v2). The compose monitor goroutine, which watches container state after startup, dereferences a nil pointer when running via the podman shim. This is a bug in Docker Compose v2's integration with podman. The container itself started successfully (verified with `curl -s http://localhost:8080` returning 200) — only the compose supervisor process crashed.

**Fix:** Replaced both `podman-up` and `podman-down` targets with direct `podman` commands, bypassing compose entirely:

```bash
# podman-up
podman run -d --name claude-hello-world -p 8080:80 localhost/claude-hello-world:latest

# podman-down
podman rm -f claude-hello-world
```

---

## Step 18: Debug — GitHub Actions Failing (Nx Cloud Not Configured)

Every push to `main` triggered a CI run that failed after ~10 minutes with:

```
NX  Action Required - Retrying in 30 seconds (Attempt N of 20)
Repository connected: Action Required
Finish your setup for CI to continue: https://cloud.nx.app/connect/...

NX  Action Required - Finish your Nx Cloud setup then restart this job.
```

**Diagnosis:** Nx 22 generates a `.github/workflows/ci.yml` that uses distributed task execution via Nx Cloud:

```yaml
- run: npx nx start-ci-run --distribute-on="3 linux-medium-js" --stop-agents-after="e2e-ci"
```

This step waits for the repository to be connected to `cloud.nx.app` before proceeding. Since Nx Cloud was never configured for this repo, it retried every 30 seconds for 20 attempts (~10 minutes) and then failed. All CI runs since the first commit were affected.

The generated workflow also referenced targets that don't apply here (`typecheck`, `e2e-ci`) and used `nx record` and `nx fix-ci` — all Nx Cloud features.

**Debugging:**
```bash
gh run list --repo joebarbere/claude-hello-world --limit 5
# All runs: completed / failure / ~10m26s each

gh run view <run-id> --repo joebarbere/claude-hello-world --log-failed
# => NX  Action Required - Retrying in 30 seconds (Attempt 1 of 20)
# => NX  Action Required - Finish your Nx Cloud setup then restart this job.
```

**Fix:** Replaced `.github/workflows/ci.yml` entirely with a minimal workflow — no Nx Cloud, no distributed agents, no external service dependencies:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npx nx run-many --target=lint --projects=shell,weather-app,weatheredit-app --parallel=3
      - run: npx nx run-many --target=build --projects=shell,weather-app,weatheredit-app --configuration=production --parallel=3
```

CI now passes in ~2 minutes.

---

## Step 19: Debug — Shell Root Path Shows Blank White Screen

After a successful `podman-build` and `podman-up`, navigating to `http://localhost:8080/` showed a blank white screen, while `/weather-app/` and `/weatheredit-app/` rendered correctly.

**Diagnosis:** The shell bootstraps Angular and Webpack Module Federation simultaneously tries to fetch the remote entry files (`/weather-app/remoteEntry.mjs` and `/weatheredit-app/remoteEntry.mjs`). The `nginx:alpine` image's default `mime.types` file does not include a mapping for the `.mjs` extension, so nginx served those files with `Content-Type: application/octet-stream`. Browsers enforce strict MIME type checking for ES module scripts and refuse to execute them, causing the shell's Module Federation initialization to fail before Angular could render anything.

The `/weather-app/` and `/weatheredit-app/` paths appeared to work because nginx served each remote's standalone `index.html` directly — completely bypassing Module Federation.

Browser console confirmed:
```
Failed to load module script: Expected a JavaScript-or-Wasm module script but the
server responded with a MIME type of "application/octet-stream". Strict MIME type
checking is enforced for module scripts per HTML spec.
```

**Fix:** Added a `sed` command to the `Containerfile.nginx` runner stage to patch nginx's built-in `mime.types` file, appending `mjs` to the existing `application/javascript` entry:

```dockerfile
FROM nginx:alpine AS runner
COPY nginx/nginx.conf /etc/nginx/nginx.conf
RUN sed -i 's|application/javascript\s*js;|application/javascript js mjs;|' /etc/nginx/mime.types
```

A `types {}` block in `nginx.conf` was considered but rejected — a second `types` block in the same context *replaces* the included `mime.types` entirely rather than merging with it, which would break MIME types for all other file extensions.

---

## Step 20: Add .NET Weather API to the Monorepo

Added a .NET 9 Web API project (`weather-api`) to the Nx monorepo.

**Plugin install:** Installed the `@nx-dotnet/core` community plugin (v3.0.2) and ran `nx g @nx-dotnet/core:init` to scaffold the required config files (`Directory.Build.props`, `Directory.Build.targets`, `.config/dotnet-tools.json`).

**Generator incompatibility:** The `@nx-dotnet/core:app` generator failed due to a version mismatch — the plugin bundles `@nx/js@21.4.1`, which references an internal module path (`nx/src/command-line/release/config/use-legacy-versioning`) removed in `nx@22.5.1`. Scaffolded the project manually instead:

```bash
dotnet new webapi --language "C#" --name WeatherApi --output apps/weather-api
```

**Nx registration:** Created `apps/weather-api/project.json` manually, wiring in `@nx-dotnet/core` executors for `build`, `serve`, `test`, and `lint` targets. Tagged `type:app` and `platform:dotnet`.

**Scalar API UI:** The .NET 9 webapi template uses the new built-in OpenAPI support (`AddOpenApi` / `MapOpenApi`) rather than Swashbuckle — `/swagger` returns 404 by default. Added the `Scalar.AspNetCore` package and `app.MapScalarApiReference()` to expose an API reference UI at `/scalar/v1`.

**Executor fix:** The `project.json` initially used `@nx-dotnet/core:run` for the serve target, which does not exist in the plugin's `executors.json`. Corrected to `@nx-dotnet/core:serve`.

**NX_DAEMON workaround:** After a successful `dotnet build`, the Nx Daemon hangs indefinitely while recalculating the project graph. Prefixing commands with `NX_DAEMON=false` resolves this.

---

## Step 21: Containerize the Weather API

Added a lightweight Containerfile and Nx podman targets for the weather-api.

**`apps/weather-api/Containerfile`** — two-stage build:
1. Stage 1 (`builder`): `mcr.microsoft.com/dotnet/sdk:9.0-alpine` — copies only `apps/weather-api/` into the image (no workspace tooling needed), runs `dotnet restore` then `dotnet publish -c Release -o /app/publish`
2. Stage 2 (`runner`): `mcr.microsoft.com/dotnet/aspnet:9.0-alpine` — copies the published output from the builder; contains only the ASP.NET runtime, not the SDK

The build context is the workspace root so the `COPY apps/weather-api/ ./` path resolves correctly. `Directory.Build.props` and `Directory.Build.targets` are not copied into the image — the `-o /app/publish` flag makes the workspace output path overrides irrelevant inside the container.

**Nx targets added to `apps/weather-api/project.json`:**

| Target | Command |
|--------|---------|
| `podman-build` | `podman build -t weather-api -f apps/weather-api/Containerfile .` |
| `podman-up` | `podman run -d --name weather-api -p 5221:8080 localhost/weather-api:latest` |
| `podman-down` | `podman rm -f weather-api` |

Port 5221 on the host maps to 8080 in the container (ASP.NET Core's default HTTP port in container environments, set via `ASPNETCORE_HTTP_PORTS`). Port 5221 was chosen to avoid conflicts with the dev server (5220) and the Angular MFE container (8080).

The Scalar API reference UI (`/scalar/v1`) is not available in the containerized build — `MapScalarApiReference()` is only registered when `ASPNETCORE_ENVIRONMENT=Development`.

---

## Step 22: Kubernetes Configuration and podman play kube

Added a Kubernetes Pod manifest and Nx targets to run both containers together via `podman play kube`.

**`k8s/pod.yaml`** — two Pod specs in a single YAML file (separated by `---`):

| Pod | Image | Host Port | Container Port |
|-----|-------|-----------|----------------|
| `claude-hello-world` | `localhost/claude-hello-world:latest` | 8080 | 80 |
| `weather-api` | `localhost/weather-api:latest` | 5221 | 8080 |

Each app gets its own Pod so they have independent lifecycle management. `hostPort` in the container spec is how `podman play kube` binds host ports without a separate Service resource.

**Nx targets added to `apps/shell/project.json`:**

| Target | Command |
|--------|---------|
| `kube-up` | `podman play kube k8s/pod.yaml` |
| `kube-down` | `podman play kube k8s/pod.yaml --down` |

Both images (`localhost/claude-hello-world:latest` and `localhost/weather-api:latest`) must be built before running `kube-up`. The `--down` flag on `kube-down` stops and removes all pods defined in the manifest.

---

## Step 23: Weather Data Table in weather-app via nginx Proxy

Connected the weather-app Angular remote to the weather-api through an nginx reverse proxy.

**`nginx/nginx.conf`** — added a `/weather` proxy location:

```nginx
location /weather {
  proxy_pass http://host.containers.internal:5221/weatherforecast;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

`host.containers.internal` is the Podman-provided hostname that resolves to the host machine from within a container. Since the weather-api pod binds `hostPort: 5221`, nginx can reach it at `host.containers.internal:5221` regardless of whether the containers are started with `podman-up` or `kube-up`. The path is rewritten from `/weather` to `/weatherforecast` by the `proxy_pass` directive.

**`apps/shell/src/app/app.config.ts`** — added `provideHttpClient()` to the shell's environment providers. Module Federation remotes share the shell's Angular DI environment injector at runtime, so HttpClient must be provided at the shell level for remote components to inject it.

**`apps/weather-app/src/app/remote-entry/entry.ts`** — replaced the NxWelcome placeholder with a weather forecast component:
- Uses `inject(HttpClient)` and Angular signals (`signal()`) for state
- On `ngOnInit`, fetches `GET /weather` and stores the response
- Renders a styled HTML table with Date, Temp (°C), Temp (°F), and Summary columns using Angular's `@for` / `@if` control flow syntax
- Shows a loading state while the request is in flight and an error message on failure

---

## Step 24: Fix Weather Table Not Visible in Dev Mode

The weather table rendered correctly in the containerized setup but was invisible when running the dev server (`nx serve shell`). The Angular component showed the error state instead of data.

**Diagnosis:** In dev mode the webpack dev server handles all requests at `localhost:4200`. There was no proxy rule for `/weather`, so requests from the weather-app component fell through to the dev server, which returned a 404. The nginx `/weather` proxy only exists inside the container — it has no effect during local development.

**Fix:** Added `apps/shell/proxy.conf.json` to proxy `/weather` to the local weather-api dev server:

```json
{
  "/weather": {
    "target": "http://localhost:5220",
    "pathRewrite": {
      "^/weather": "/weatherforecast"
    },
    "secure": false,
    "changeOrigin": true
  }
}
```

Wired it into the `serve` target in `apps/shell/project.json`:

```json
"options": {
  "port": 4200,
  "publicHost": "http://localhost:4200",
  "proxyConfig": "apps/shell/proxy.conf.json"
}
```

To see the table in dev mode, run both servers:

```bash
# Terminal 1
NX_DAEMON=false npx nx serve weather-api

# Terminal 2
npx nx serve shell --devRemotes=weather-app,weatheredit-app
```

---

## Step 25: Add build dependsOn to podman-build Targets

`npx nx podman-build weather-api` would run the container build against whatever was already on disk — there was no guarantee the .NET project had been compiled first. Added `"dependsOn": ["build"]` to the `podman-build` target in `apps/weather-api/project.json` so Nx always runs `dotnet build` before the container build.

The shell's `podman-build` already had `"dependsOn": ["build-all"]`, which covers the production builds for shell, weather-app, and weatheredit-app before the nginx container image is assembled.

---

## Step 26: Fix — Nx Daemon Hangs in dotnet Build Context

`npx nx podman-build weather-api` failed during the `dotnet build` step with:

```
error MSB3073: The command "node ../..//node_modules/@nx-dotnet/core/src/tasks/check-module-boundaries.js
  --project-root "apps/weather-api"" exited with code 1.
```

**Diagnosis:** `Directory.Build.targets` runs the `check-module-boundaries.js` script as a `BeforeTargets="Build"` hook via MSBuild's `<Exec>`. When called from within dotnet, the script attempts to connect to the Nx Daemon to calculate the project graph, but the daemon connection hangs indefinitely and eventually exits with code 1. Running the script directly with `NX_DAEMON=false` confirmed it completes successfully — the issue is specific to the daemon being unavailable or unreachable from within the MSBuild subprocess context.

**Fix:** Added `EnvironmentVariables="NX_DAEMON=false"` to the `<Exec>` task in `Directory.Build.targets` so the script bypasses the daemon and calculates the project graph inline:

```xml
<Exec Command="node $(NodeModulesRelativePath)/node_modules/@nx-dotnet/core/src/tasks/check-module-boundaries.js
  --project-root &quot;$(MSBuildProjectDirRelativePath)&quot;"
  EnvironmentVariables="NX_DAEMON=false"/>
```

---

## Step 27: Rename Containerfile to Containerfile.nginx

Renamed the root `Containerfile` to `Containerfile.nginx` to distinguish it from `apps/weather-api/Containerfile` and make its purpose (nginx MFE image) clear at a glance.

Updated references:
- `apps/shell/project.json` — `podman-build` target: `-f Containerfile` → `-f Containerfile.nginx`
- `RUN.md` — build command and description

---

## Step 28: Add PostgreSQL Container

Added a lightweight PostgreSQL 17 image and wired it into the Kubernetes kube workflow.

**`apps/postgres/Containerfile`** — extends `postgres:17-alpine` (the official Alpine-based image, ~90 MB) with default dev credentials baked in as `ENV` defaults:

```dockerfile
FROM postgres:17-alpine

ENV POSTGRES_DB=appdb
ENV POSTGRES_USER=appuser
ENV POSTGRES_PASSWORD=apppassword

EXPOSE 5432
```

**`k8s/pod.yaml`** — added a third Pod spec:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres
  labels:
    app: postgres
spec:
  containers:
    - name: postgres
      image: localhost/postgres:latest
      ports:
        - containerPort: 5432
          hostPort: 5432
      env:
        - name: POSTGRES_DB
          value: appdb
        - name: POSTGRES_USER
          value: appuser
        - name: POSTGRES_PASSWORD
          value: apppassword
```

The env vars in the pod spec override the `ENV` defaults from the image, making credentials configurable at runtime without rebuilding.

**`apps/postgres/project.json`** — new project with a `podman-build` target:

| Target | Command |
|--------|---------|
| `podman-build` | `podman build -t postgres -f Containerfile .` |

`kube-up` in the shell project now has `"dependsOn": ["postgres:podman-build"]` so the image is always current before the pods start.

Connect with: `psql -h localhost -p 5432 -U appuser -d appdb`

---

## Step 29: Full REST API with Repository Pattern and EF Core

Refactored `weather-api` from a single-file random data generator into a full CRUD REST API with a configurable repository layer and PostgreSQL support via Entity Framework Core.

### File structure added

```
apps/weather-api/
├── Models/
│   └── WeatherForecast.cs          — EF entity (class, not record; NotMapped TemperatureF)
├── Repositories/
│   ├── IWeatherForecastRepository.cs
│   ├── RandomWeatherForecastRepository.cs   — read-only, random data
│   ├── InMemoryWeatherForecastRepository.cs — full CRUD, no DB required
│   └── EfWeatherForecastRepository.cs       — full CRUD, PostgreSQL via EF Core
├── Data/
│   ├── WeatherDbContext.cs
│   ├── WeatherDbContextFactory.cs  — design-time factory for dotnet ef tooling
│   └── Migrations/                 — generated by dotnet ef migrations add
```

### Repository implementations

| Repository | Config value | Behavior |
|------------|-------------|----------|
| `RandomWeatherForecastRepository` | `"Random"` (default) | Read-only; generates random data each call; throws `NotSupportedException` on writes |
| `InMemoryWeatherForecastRepository` | `"InMemory"` | Full CRUD; registered as Singleton; data persists for process lifetime |
| `EfWeatherForecastRepository` | `"EfCore"` | Full CRUD; backed by PostgreSQL; auto-migrates on startup |

### Configuration (`appsettings.json`)

```json
{
  "Repository": "Random",
  "ConnectionStrings": {
    "DefaultConnection": "Host=localhost;Port=5432;Database=appdb;Username=appuser;Password=apppassword"
  }
}
```

Switch repositories by changing `"Repository"` to `"Random"`, `"InMemory"`, or `"EfCore"`. The connection string is only used when `"EfCore"` is selected.

### REST endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/weatherforecast` | List all forecasts |
| `GET` | `/weatherforecast/{id}` | Get by ID |
| `POST` | `/weatherforecast` | Create new forecast |
| `PUT` | `/weatherforecast/{id}` | Update forecast |
| `DELETE` | `/weatherforecast/{id}` | Delete forecast |

Write endpoints return `405 Method Not Allowed` when the `Random` repository is active.

### NuGet packages added

- `Microsoft.EntityFrameworkCore.Design 9.*` — EF Core tooling (design-time only, `PrivateAssets=all`)
- `Npgsql.EntityFrameworkCore.PostgreSQL 9.*` — PostgreSQL provider

### Design-time factory

`WeatherDbContextFactory` implements `IDesignTimeDbContextFactory<WeatherDbContext>` so `dotnet ef migrations add` can create the context without running the full app (which requires the repository config to select EfCore).

---

## Step 30: Weather Forecast CRUD Interface in weatheredit-app

Replaced the placeholder `NxWelcome` component in `apps/weatheredit-app` with a full CRUD management interface for the weather-api.

### Files

| File | Description |
|------|-------------|
| `apps/weatheredit-app/src/app/remote-entry/entry.ts` | Standalone Angular component — full CRUD UI |
| `apps/weatheredit-app/src/app/remote-entry/entry.css` | External stylesheet (moved out of inline to avoid component CSS budget warning) |
| `apps/weatheredit-app/project.json` | Raised `anyComponentStyle` budget from 4 kB to 8 kB |

The unused `nx-welcome.ts` was deleted.

### Features

- **List** — fetches all forecasts on load via `GET /weather`
- **Create** — "New Forecast" button opens an inline form; `POST /weather` on submit
- **Edit** — pencil icon prefills the form with the row's values; `PUT /weather/{id}` on submit
- **Delete** — trash icon shows an inline "Delete? Yes / No" confirmation; `DELETE /weather/{id}` on confirm
- Loading spinner, empty state with call-to-action, and dismissible error alert
- Row fades out while a delete request is in flight
- Save button disabled and shows spinner while saving; form submission disabled while invalid

### Styling

Professionally styled with a card-based layout, subtle shadows, and a neutral gray/blue palette:

- Temperature badges color-coded by range: cold (blue) → cool (sky) → mild (green) → warm (amber) → hot (rose)
- Tabular-numeric columns for IDs and temperatures
- Responsive 3-column form grid (collapses to 1 on narrow viewports)
- Focus ring on form inputs, hover/active states on all buttons
- SVG icons for Edit and Delete actions

### API compatibility

All five HTTP methods (`GET`, `POST`, `PUT`, `DELETE`) route through the existing `/weather` proxy:
- Dev: `proxy.conf.json` rewrites `^/weather` → `/weatherforecast`
- Container: nginx `location /weather` proxies to `host.containers.internal:5221/weatherforecast`

Write operations return `405` when the weather-api is configured with `"Repository": "Random"`. Switch to `"InMemory"` or `"EfCore"` for full CRUD support.

---

## Step 31: Debug — weather-api Cannot Reach PostgreSQL in Container

After switching `appsettings.json` to `"Repository": "EfCore"` and running `nx kube-up shell`, the weather-api pod crashed on startup:

```
Npgsql.NpgsqlException: Failed to connect to 127.0.0.1:5432
  ---> System.Net.Sockets.SocketException (111): Connection refused
```

**Diagnosis:** Inside a container, `localhost` (and `127.0.0.1`) resolves to the container's own loopback interface — not the host machine. The connection string `Host=localhost;Port=5432` therefore never reaches the postgres pod, which is bound to `hostPort: 5432` on the host. The same pattern was already solved for the nginx → weather-api proxy using `host.containers.internal`, which is the hostname Podman provides inside containers to reach the host.

**Fix:** Added a `ConnectionStrings__DefaultConnection` environment variable to the weather-api pod spec in `k8s/pod.yaml`:

```yaml
env:
  - name: ConnectionStrings__DefaultConnection
    value: Host=host.containers.internal;Port=5432;Database=appdb;Username=appuser;Password=apppassword
```

ASP.NET Core's configuration system treats `__` as a hierarchy separator in environment variable names, so `ConnectionStrings__DefaultConnection` overrides `ConnectionStrings:DefaultConnection` from `appsettings.json` at runtime without any code changes. Local dev continues to use `localhost` from `appsettings.json` unchanged.

---

## Final Verification

### Individual container workflow

```bash
# Build all images
npx nx podman-build shell          # builds nginx MFE image (claude-hello-world)
npx nx podman-build weather-api    # builds .NET API image
npx nx podman-build postgres       # builds PostgreSQL image

# Run individually
npx nx podman-up shell             # → http://localhost:8080 (Angular MFE)
npx nx podman-up weather-api       # → http://localhost:5221/weatherforecast

# Stop
npx nx podman-down shell
npx nx podman-down weather-api
```

### Kubernetes workflow (all three containers together)

```bash
# Build images (postgres image built automatically by dependsOn)
npx nx podman-build shell
npx nx podman-build weather-api

# Start all pods
npx nx kube-up shell

# Verify
curl http://localhost:8080              # Angular shell
curl http://localhost:8080/weather-app/       # weather-app remote (weather table)
curl http://localhost:8080/weather      # nginx → weather-api proxy
curl http://localhost:5221/weatherforecast  # weather-api direct
psql -h localhost -p 5432 -U appuser -d appdb  # PostgreSQL

# Stop all pods
npx nx kube-down shell
```

### Weather API repository selection

Change `"Repository"` in `apps/weather-api/appsettings.json`:

| Value | Behavior |
|-------|----------|
| `"Random"` (default) | Read-only, random data, no DB |
| `"InMemory"` | Full CRUD, in-process storage, no DB |
| `"EfCore"` | Full CRUD, persisted to PostgreSQL |

### Containerfiles

| File | Base image | Purpose |
|------|-----------|---------|
| `Containerfile.nginx` | `node:20-alpine` → `nginx:alpine` | Angular MFE (shell + weather-app + weatheredit-app) |
| `apps/weather-api/Containerfile` | `dotnet/sdk:9.0-alpine` → `dotnet/aspnet:9.0-alpine` | .NET Weather API |
| `apps/postgres/Containerfile` | `postgres:17-alpine` | PostgreSQL database |
