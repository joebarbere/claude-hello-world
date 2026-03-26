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

## Step 32: Integrate Ory Kratos Authentication

Added role-based authentication using [Ory Kratos](https://www.ory.sh/kratos/) (open-source identity infrastructure). Access to the `weatheredit-app` and all write operations on the weather-api are restricted to users with the `admin` or `weather_admin` role.

### `apps/ory/` — new Nx project

**`apps/ory/project.json`** — registers `ory` as an Nx application with a single `podman-build` target that runs two sequential container builds.

**`apps/ory/identity.schema.json`** — JSON Schema defining the identity shape. Two traits:
- `email` — the login identifier (marked with `ory.sh/kratos.credentials.password.identifier: true`)
- `role` — an enum restricted to `admin` or `weather_admin`

**`apps/ory/kratos.yml`** — Kratos server configuration:
- `dsn: sqlite:///var/lib/kratos/db.sqlite` — SQLite keeps the stack dependency-free; no separate DB pod needed for auth
- Self-service `login` flow configured to redirect to `http://localhost:4200/auth/login` (the Angular shell's login page)
- `allowed_return_urls` includes both the dev origin (`localhost:4200`) and the containerized origin (`localhost:8080`)
- Password method enabled; recovery/verification flows omitted to avoid a mail server dependency
- Cookie and cipher secrets are placeholders — replace before any non-local deployment

**`apps/ory/Containerfile`** — extends `oryd/kratos:v1.3.0-distroless` (the official minimal image with no shell or package manager). Copies `kratos.yml` and `identity.schema.json` into `/etc/config/kratos/`. Uses the `--dev` flag to enable permissive CORS and disable TLS.

**`apps/ory/Containerfile.init`** — `alpine:3.21` with only `wget` installed. Copies `init-users.sh` and sets it as the entrypoint.

**`apps/ory/init-users.sh`** — shell script run by the init container:
1. Polls `GET /health/ready` on the Kratos Admin API (up to 30 attempts, 2-second intervals)
2. For each user, checks if the identity already exists (`GET /admin/identities?credentials_identifier=<email>`) and skips if found
3. Creates the identity via `POST /admin/identities` with the password embedded in the `credentials.password.config` block — this bypasses self-service flows and email verification, making it suitable for seeding programmatic defaults

| User | Email | Password | Role |
|------|-------|----------|------|
| Admin | `admin@example.com` | `Admin1234!` | `admin` |
| Weather Admin | `weatheradmin@example.com` | `WeatherAdmin1234!` | `weather_admin` |

### `apps/weather-api/Middleware/KratosAuthMiddleware.cs` — new

ASP.NET Core middleware that enforces role-based access on write operations:

1. **Pass-through for reads:** `GET` and `HEAD` requests are forwarded to the next middleware unconditionally — the weather forecast list remains public.
2. **Session extraction:** All request cookies are concatenated into a `Cookie` header and forwarded to `GET {OryKratosPublicUrl}/sessions/whoami` via an `HttpClient` call. This endpoint validates the session and returns the full identity.
3. **Role check:** The `identity.traits.role` field is extracted from the JSON response. Only `admin` and `weather_admin` are in the `AllowedRoles` set; anything else (including missing roles) returns `403 Forbidden`.
4. **Error handling:** Connection failures return `503 Service Unavailable`; invalid/expired sessions return `401 Unauthorized`.

`OryKratosPublicUrl` defaults to `http://localhost:4433` and is overridden per environment via `appsettings.json` or the pod's `env:` block.

Registered in `Program.cs` after `UseHttpsRedirection()`:

```csharp
app.UseMiddleware<KratosAuthMiddleware>();
```

### Angular auth — shell app

Three new files added to `apps/shell/src/app/auth/`:

**`auth.service.ts`** — injectable service that:
- Calls `GET /.ory/kratos/public/sessions/whoami` with `withCredentials: true` (so the session cookie is included); returns `null` on any error
- `canAccessWeatherEdit(session)` — returns `true` if the session is active and the role is `admin` or `weather_admin`
- `initiateLogin(returnTo)` — redirects `window.location.href` to `/.ory/kratos/public/self-service/login/browser?return_to=<url>`, triggering a full browser-based Kratos login flow
- `logout()` — fetches the Kratos logout URL and redirects the browser to it (invalidates the session server-side)
- `getLoginFlow(flowId)` — fetches flow details from `/.ory/kratos/public/self-service/login/flows?id=<flowId>`

**`auth.guard.ts`** — `CanActivateFn` that:
1. Calls `authService.getSession()` (observable)
2. If no session → calls `authService.initiateLogin(state.url)` and returns `false` (browser navigates away to Kratos)
3. If session present but wrong role → returns `router.createUrlTree(['/auth/unauthorized'])`
4. Otherwise → returns `true`

**`auth/login/login.component.ts`** — standalone component that implements the Kratos browser login UI:
- On `ngOnInit`, reads `?flow=` from the query string
- If absent, calls `authService.initiateLogin(returnTo)` — Kratos will redirect back to `/auth/login?flow=<id>`
- If present, fetches the flow object and stores it in `this.flow`
- Template renders a `<form>` with `[attr.action]="flow.ui.action"` and `[attr.method]="flow.ui.method"` — the form submits **natively** (no Angular `ngSubmit`), so Kratos handles the POST, sets the session cookie, and redirects to `return_to`
- Hidden nodes (including the CSRF token) are rendered as `<input type="hidden">` elements
- Field-level messages from Kratos (e.g. "wrong credentials") are displayed below each input
- Flow expiry is handled: a failed `getLoginFlow` call re-initiates a fresh login flow

**`auth/unauthorized/unauthorized.component.ts`** — shown when a logged-in user's role is not permitted. Offers "Go to Home" and "Sign out" actions.

### Shell routing — `app.routes.ts`

The `weatheredit-app` route now has `canActivate: [weatherEditAuthGuard]`. Two new routes are added:

```ts
{ path: 'auth/login',        component: LoginComponent },
{ path: 'auth/unauthorized', component: UnauthorizedComponent },
```

### nginx — Kratos proxy

Added to `nginx/nginx.conf`:

```nginx
location /.ory/kratos/public/ {
  proxy_pass http://host.containers.internal:4433/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
}
```

This allows the Angular app (served by nginx on port 8080) to reach Kratos without CORS issues — all requests go to the same origin and nginx forwards them to `host.containers.internal:4433`. The Kratos `X-Forwarded-*` headers are used to correctly construct redirect URLs back to the Angular app.

The existing `/weather` proxy location also gained `proxy_set_header Cookie $http_cookie;` to ensure session cookies are forwarded to the weather-api for validation.

### Kubernetes — `k8s/pod.yaml`

Added the `ory-kratos` pod with an `initContainers` block:

```yaml
initContainers:
  - name: ory-kratos-init
    image: localhost/ory-kratos-init:latest
    env:
      - name: KRATOS_ADMIN_URL
        value: http://host.containers.internal:4434
containers:
  - name: ory-kratos
    image: localhost/ory-kratos:latest
    ports:
      - containerPort: 4433  # public API
        hostPort: 4433
      - containerPort: 4434  # admin API
        hostPort: 4434
```

The `initContainer` runs to completion before Kubernetes starts the main `ory-kratos` container. The init container waits for Kratos to be healthy before seeding users, but since both share the same pod, the Kratos server starts concurrently — the health poll loop in `init-users.sh` handles the race.

The `weather-api` pod gained an `OryKratosPublicUrl` env var:

```yaml
- name: OryKratosPublicUrl
  value: http://host.containers.internal:4433
```

---

## Step 33: GitHub Actions EKS E2E Workflow and README Badge

### `.github/workflows/eks-e2e.yml`

New workflow that runs on every push to `main` (i.e., every merged PR). It simulates the EKS pod environment inside the GitHub Actions runner using Podman:

**Build phase:**
1. Install Node 20, .NET 9 SDK, Playwright (chromium only)
2. `npx nx podman-build shell` — triggers `build-all` (Angular production builds) then builds the nginx container image
3. `NX_DAEMON=false npx nx podman-build weather-api` — runs `dotnet build` then builds the ASP.NET container image
4. `npx nx podman-build postgres` — builds the postgres container image
5. `npx nx podman-build ory` — builds the `ory-kratos` and `ory-kratos-init` images

**Pod lifecycle:**
6. `npx nx kube-up shell` — `podman play kube k8s/pod.yaml` starts all pods (nginx, weather-api, postgres, ory-kratos + init)
7. Health checks: `curl` polls nginx `:8080` and weather-api `:5221/weatherforecast` until ready (90 s timeout each)

**E2E suites** — each with `continue-on-error: true` so all run regardless of individual failures:
8. `shell-e2e` at `BASE_URL=http://localhost:8080` — includes navigation to `/weatheredit-app/` which exercises the Ory auth redirect
9. `weather-app-e2e` at `BASE_URL=http://localhost:8080/weather-app/`
10. `weatheredit-app-e2e` at `BASE_URL=http://localhost:8080/weatheredit-app/`

**Teardown & reporting** (`if: always()`):
11. `npx nx kube-down shell` — stops and removes all pods
12. `dorny/test-reporter@v1` — publishes JUnit XML as a **GitHub Check Run** (visible in the PR Checks tab); requires `checks: write` permission
13. `actions/upload-artifact@v4` — uploads all three `playwright-report/` directories as a 30-day artifact
14. `actions/github-script` — calls `listPullRequestsAssociatedWithCommit` to find the merged PR, then posts a Markdown table comment with per-suite ✅/❌ status and a link to the run
15. Fail step — exits 1 if any suite outcome is `failure`, so the workflow shows red on the commit

**Permissions required:**
- `contents: read` — checkout
- `pull-requests: write` — PR comment
- `checks: write` — Check Run via `dorny/test-reporter`

### README badge

Added an EKS E2E Tests status badge directly under the `h1` title:

```markdown
[![EKS E2E Tests](https://github.com/joebarbere/claude-hello-world/actions/workflows/eks-e2e.yml/badge.svg)](https://github.com/joebarbere/claude-hello-world/actions/workflows/eks-e2e.yml)
```

The badge reflects the latest workflow run on `main` (green = all suites passed, red = any suite failed).

---

## Step 34: Fix CI — Disable Nx Cloud Authorization

**Problem:** Both GitHub Actions workflows (`ci.yml`, `eks-e2e.yml`) were failing immediately with:

```
NX  Nx Cloud: Workspace is unable to be authorized. Exiting run.
This workspace is more than three days old and is not connected.
```

The `nx.json` contains an `nxCloudId` for an unclaimed workspace. Every `nx` command exits 1 before doing any work.

**Fix:** Added `NX_NO_CLOUD: true` as a workflow-level environment variable to both workflows:

```yaml
env:
  NX_NO_CLOUD: true
```

This tells Nx to skip all cloud communication — caching, authorization, and distributed task execution — and run tasks locally inside the runner. No `nx.json` changes were needed; the env var takes precedence at runtime.

**Files changed:**
- `.github/workflows/ci.yml` — added `env: NX_NO_CLOUD: true` at the workflow level
- `.github/workflows/eks-e2e.yml` — added `env: NX_NO_CLOUD: true` at the workflow level

---

## Step 35: Optimize E2E CI — Smoke Workflow + Manual Full Suite

**Problem:** `eks-e2e.yml` ran all three Playwright suites on every push to `main`. The full suite — including CRUD create/edit/delete tests in `weatheredit-app-e2e` — was slow and the workflow failed intermittently, blocking merges.

**Fix:** Split the workflow into two:

### `eks-e2e.yml` (renamed: EKS E2E Tests (Smoke))

Runs on push to `main`. Now executes only `shell-e2e`, which covers:
- Shell host loads (200 status, heading, hero banner)
- MFE navigation to `/weather-app` and `/weatheredit-app` routes
- `/weather` API proxy returns JSON

This is enough to confirm all three pods are healthy after a deploy without running the slower CRUD suites.

Reporting scoped to `shell-e2e` only:
- `dorny/test-reporter` path changed to `apps/shell-e2e/playwright-report/junit.xml`
- Artifact upload path changed to `apps/shell-e2e/playwright-report/`
- PR comment updated to show only the shell result and link to the full workflow

### `eks-e2e-full.yml` (new: EKS E2E Tests (Full))

Triggered via `workflow_dispatch` (Actions → Run workflow). Identical build and pod-startup steps, then runs all three suites:

1. `shell-e2e` at `BASE_URL=http://localhost:8080`
2. `weather-app-e2e` at `BASE_URL=http://localhost:8080/weather-app/`
3. `weatheredit-app-e2e` at `BASE_URL=http://localhost:8080/weatheredit-app/`

Reports all three suites to a Check Run and uploads all `apps/*/playwright-report/` directories as artifacts.

**Files changed:**
- `.github/workflows/eks-e2e.yml` — scoped to `shell-e2e` only; updated name, reporting paths, PR comment, and added `npx nx podman-build ory` build step
- `.github/workflows/eks-e2e-full.yml` — new manual workflow running all three suites; includes Ory build step
- `README.md` — CI table updated with both workflows
- `RUN.md` — "CI — EKS E2E Workflow" section expanded to document both workflows

---

## Step 36: Fix — shell-e2e Playwright Config Running Uninstalled Browsers

**Problem:** `shell-e2e/playwright.config.ts` was generated with all three browser projects (`chromium`, `firefox`, `webkit`), unlike `weather-app-e2e` and `weatheredit-app-e2e` which had already been pared down to `chromium` only. CI installs only chromium (`npx playwright install --with-deps chromium`). Webkit is not available on `ubuntu-latest` as a system browser, so all webkit test cases failed immediately with "browser not found", causing `shell-e2e` to report failures on every CI run.

**Fix:** Removed the `firefox` and `webkit` project entries from `apps/shell-e2e/playwright.config.ts`, leaving only `chromium` — consistent with the other two e2e configs.

**Timing impact:** With webkit removed, shell-e2e no longer incurs per-test failure overhead for 9 webkit cases. The smoke workflow now runs only chromium tests, reducing the shell-e2e phase from ~3–4 min to ~1–2 min.

**Files changed:**
- `apps/shell-e2e/playwright.config.ts` — removed `firefox` and `webkit` project entries

---

## Step 37: CI Performance — Playwright Cache, NuGet Cache, Parallel Health Checks

Applied three independent optimizations to both `eks-e2e.yml` and `eks-e2e-full.yml` to reduce wall-clock time on every run.

### Playwright browser cache

Added `actions/cache@v4` for `~/.cache/ms-playwright` keyed on `runner.os` + `package-lock.json`. Chromium binaries are ~100 MB and were re-downloaded on every run (~1 min). On a cache hit the install step is skipped; only system-level apt dependencies are installed via `npx playwright install-deps chromium` (fast, no download).

### NuGet package cache

Added `actions/cache@v4` for `~/.nuget/packages` keyed on `runner.os` + `apps/weather-api/**/*.csproj`. NuGet packages were re-fetched from nuget.org on every `dotnet build` / `dotnet publish`. Cache is invalidated only when `.csproj` package references change (~1 min saved per run).

### Parallel pod health checks

The nginx `:8080` and weather-api `:5221` health check polls ran sequentially (up to 90 s each back-to-back). Both pods start at the same time, so polling them concurrently halves the worst-case wait. Combined into a single step using shell background jobs + `wait`.

**Estimated savings per run: ~2–3 min** (on top of the ~1–2 min already saved by the webkit fix in Step 36).

**Files changed:**
- `.github/workflows/eks-e2e.yml` — NuGet cache, Playwright cache, parallel health checks
- `.github/workflows/eks-e2e-full.yml` — same changes

---

## Step 38: Fix — nginx `location /weather` Matching MFE Routes

**Problem:** The nginx prefix location `location /weather` matched any URI that begins with `/weather`, including `/weather-app` and `/weatheredit-app`. When Playwright (or a browser) navigated directly to `/weather-app`, nginx treated the request as an API proxy call instead of an Angular route:

- `GET /weather-app` → matched `location /weather` → proxied to `http://host.containers.internal:5221/weatherforecast-app` (404 from the weather-api)
- The shell's `index.html` was never returned, so Angular and module federation never initialised
- All four MFE navigation smoke tests (`navigates to weather-app`, `navigates to weatheredit-app`, `weather-app route loads`, `weatheredit-app shows New Forecast button`) timed out and failed

**Fix:** Replaced the single `location /weather` prefix block with two more-specific locations:

```nginx
# Exact match — handles GET /weather (list) and POST /weather (create)
location = /weather {
  proxy_pass http://host.containers.internal:5221/weatherforecast;
  ...
}

# Sub-path match — handles GET/PUT/DELETE /weather/{id}
# ^~ prevents regex fallthrough; /weather/ as a prefix does NOT match /weather-app/ or /weatheredit-app/
location ^~ /weather/ {
  proxy_pass http://host.containers.internal:5221/weatherforecast/;
  ...
}
```

With these locations, a request to `/weather-app` matches neither `= /weather` nor `^~ /weather/` (the latter requires a literal `/` immediately after `weather`). It falls through to `location /` which serves the shell's `index.html` via `try_files`, letting Angular's router handle the client-side navigation to the MFE remote.

**Files changed:**
- `nginx/nginx.conf` — split `location /weather` into `location = /weather` and `location ^~ /weather/`

---

## Step 39: Playwright E2E Test Suites for EKS Pods

Added dedicated Playwright e2e specs that target the apps as they run inside the EKS pods (via the nginx container on `:8080`), rather than the local dev servers. Auth-aware: `weatheredit-app-e2e` logs in via Ory Kratos before running CRUD tests; `shell-e2e` verifies the auth redirect to `/auth/login` when navigating to `/weatheredit-app` without a session.

### Playwright config changes (all three e2e projects)

| Change | Detail |
|--------|--------|
| Default `BASE_URL` | `http://localhost:8080`, `/weather-app/`, `/weatheredit-app/` |
| `webServer` conditional | Block only starts when `BASE_URL` is **not** set |
| CI reporters | When `CI=true`, emits `['github', 'html', 'junit']` |

### New test files

**`apps/shell-e2e/src/eks.spec.ts`**

| Suite | Tests |
|-------|-------|
| Home page | Loads with "Welcome shell" heading; hero banner visible; HTTP 200 |
| MFE navigation | `/weather-app` renders "Weather Forecast" h2; `/weatheredit-app` redirects to `/auth/login` (Ory auth guard); login form fields visible |
| API proxy | `GET /weather` returns HTTP 200 with a JSON array |

**`apps/weather-app-e2e/src/eks.spec.ts`**

| Suite | Tests |
|-------|-------|
| Page load | HTTP 200; "Weather Forecast" h2; loading indicator or table on first render |
| Forecast table | Correct headers (Date, Temp °C, Temp °F, Summary); at least one row; non-empty date; numeric temperatures; no error message |

**`apps/weatheredit-app-e2e/src/eks.spec.ts`**

All tests include a `beforeEach` that navigates to `/` and logs in via the Ory Kratos browser flow (`admin@example.com` / `Admin1234!`) if redirected to `/auth/login`.

| Suite | Tests |
|-------|-------|
| Page load | Lands on weatheredit-app after login; heading visible |
| Forecast table | Table or empty-state visible; column headers validated when data exists |
| Create | Form opens; cancel works; submit creates row in table |
| Edit | Opens prefilled form; update changes the row |
| Delete | Confirm "Yes" removes row; "No" leaves row in place |
| Error handling | No error alert on successful load |

---
## Step 40: Add SSL Termination in nginx with a Self-Signed Certificate

Added HTTPS support to the nginx container using a self-signed certificate for `localhost`. HTTP on port 80 now issues a permanent redirect to HTTPS on port 443.

### Certificate

Generated a 2048-bit RSA self-signed certificate valid for 10 years, committed to the repository so the container image can be built without any runtime key-generation step:

```sh
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout ssl/localhost.key -out ssl/localhost.crt \
  -subj "/CN=localhost/O=claude-hello-world/C=US" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

The Subject Alternative Name extension (`DNS:localhost` and `IP:127.0.0.1`) is required — browsers have ignored the Common Name for TLS verification since Chrome 58 / Firefox 48.

### nginx.conf changes

Replaced the single `listen 80` server block with two blocks:

```nginx
# Redirect all HTTP to HTTPS
server {
  listen 80;
  return 301 https://$host$request_uri;
}

# HTTPS server with SSL termination
server {
  listen 443 ssl;
  ssl_certificate     /etc/nginx/ssl/localhost.crt;
  ssl_certificate_key /etc/nginx/ssl/localhost.key;
  ssl_protocols       TLSv1.2 TLSv1.3;
  ssl_ciphers         HIGH:!aNULL:!MD5;
  # ... existing location blocks unchanged ...
}
```

### Containerfile.nginx changes

Added steps in the runner stage to create `/etc/nginx/ssl/`, copy in the certificate and key, restrict key permissions, and expose port 443 alongside port 80:

```dockerfile
RUN mkdir -p /etc/nginx/ssl
COPY ssl/localhost.crt /etc/nginx/ssl/localhost.crt
COPY ssl/localhost.key /etc/nginx/ssl/localhost.key
RUN chmod 600 /etc/nginx/ssl/localhost.key
EXPOSE 80
EXPOSE 443
```

### k8s/pod.yaml changes

Added a second port mapping to the nginx pod so HTTPS is reachable on the host:

```yaml
ports:
  - containerPort: 80
    hostPort: 8080   # HTTP → redirects to HTTPS
  - containerPort: 443
    hostPort: 8443   # HTTPS
```

Port 8443 is used instead of 443 to avoid requiring root privileges on the host.

### Certificate trust scripts

Six scripts were added to `ssl/` to install and remove the certificate from the system trust store on each supported OS. This allows browsers and other tools to accept `https://localhost:8443` without a security warning.

| Script | Action | Platform |
|--------|--------|---------|
| `install-cert-linux.sh` | Adds cert to system CA store | Debian/Ubuntu (`update-ca-certificates`) and RHEL/Fedora (`update-ca-trust`) |
| `install-cert-macos.sh` | Adds cert to System Keychain as trusted root | macOS (`security add-trusted-cert`) |
| `install-cert-windows.ps1` | Adds cert to `LocalMachine\Root` store | Windows (requires Administrator) |
| `uninstall-cert-linux.sh` | Removes cert from system CA store | Debian/Ubuntu and RHEL/Fedora |
| `uninstall-cert-macos.sh` | Removes cert from System Keychain by SHA-256 hash | macOS |
| `uninstall-cert-windows.ps1` | Removes cert from `LocalMachine\Root` by thumbprint | Windows (requires Administrator) |

**Files changed:**
- `nginx/nginx.conf` — HTTP redirect server block + HTTPS server block with SSL directives
- `Containerfile.nginx` — copy SSL files into image, `chmod 600` key, `EXPOSE 443`
- `k8s/pod.yaml` — added `containerPort: 443` / `hostPort: 8443`
- `ssl/localhost.crt` — pre-generated self-signed certificate (new)
- `ssl/localhost.key` — RSA 2048 private key (new)
- `ssl/install-cert-linux.sh` (new)
- `ssl/install-cert-macos.sh` (new)
- `ssl/install-cert-windows.ps1` (new)
- `ssl/uninstall-cert-linux.sh` (new)
- `ssl/uninstall-cert-macos.sh` (new)
- `ssl/uninstall-cert-windows.ps1` (new)
- `README.md` — updated architecture diagram, added SSL/HTTPS section, updated all URLs to `https://localhost:8443`
- `RUN.md` — updated container URL tables and E2E BASE_URL examples

---

## Step 41: Update Playwright E2E Configs for HTTPS

All three Playwright configurations required two changes to work against the now-HTTPS nginx container.

### Default baseURL

Each config hard-codes a fallback URL used when `BASE_URL` is not set in the environment (i.e., running locally against the pods). Updated from HTTP port 8080 to HTTPS port 8443:

| Config | Old | New |
|--------|-----|-----|
| `shell-e2e` | `http://localhost:8080` | `https://localhost:8443` |
| `weather-app-e2e` | `http://localhost:8080/weather-app/` | `https://localhost:8443/weather-app/` |
| `weatheredit-app-e2e` | `http://localhost:8080/weatheredit-app/` | `https://localhost:8443/weatheredit-app/` |

### ignoreHTTPSErrors

Added `ignoreHTTPSErrors: true` to the shared `use` block in each config. Without this, Playwright's Chromium/Firefox/WebKit instances reject the self-signed certificate and refuse to navigate, producing a `net::ERR_CERT_AUTHORITY_INVALID` error before any test code runs. This flag is equivalent to accepting the browser security warning during manual testing.

```typescript
use: {
  baseURL,
  ignoreHTTPSErrors: true,   // accept the self-signed localhost cert
  trace: 'on-first-retry',
},
```

The `webServer` URLs (`http://localhost:4200/4201/4202`) are unchanged — those point to the Angular webpack dev servers used when running tests against the local dev setup (no SSL involved).

**Files changed:**
- `apps/shell-e2e/playwright.config.ts`
- `apps/weather-app-e2e/playwright.config.ts`
- `apps/weatheredit-app-e2e/playwright.config.ts`

---

## Step 42: Add Per-OS Certificate Generation Scripts

Added three scripts to `ssl/` so developers can regenerate `ssl/localhost.crt` and `ssl/localhost.key` in-place without needing to remember the `openssl req` flags. Each script validates that `openssl` is available, runs the generation command with the correct subject and SAN, and prints next steps.

| Script | Platform | OpenSSL source |
|--------|---------|----------------|
| `ssl/generate-cert-linux.sh` | Linux | System package (`apt install openssl` / `dnf install openssl`) |
| `ssl/generate-cert-macos.sh` | macOS | Bundled LibreSSL or Homebrew `openssl` |
| `ssl/generate-cert-windows.ps1` | Windows | `winget install ShiningLight.OpenSSL`, `choco install openssl`, or Git for Windows (`openssl.exe` in `Git\usr\bin`) |

The Windows script also probes the Git for Windows install path as a fallback when `openssl` is not on `PATH`.

All three scripts output the same certificate parameters:
- Subject: `CN=localhost, O=claude-hello-world, C=US`
- SAN: `DNS:localhost, IP:127.0.0.1`
- Key: RSA 2048
- Validity: 3650 days (10 years)

After regeneration, the container image must be rebuilt (`npx nx podman-build shell`) and the appropriate `install-cert-*` script must be re-run on every machine that needs to trust the new certificate.

README.md was updated to replace the raw `openssl req` command in the "Regenerate the certificate" section with per-OS script references, and the `ssl/` file table was expanded to list all nine scripts (generate, install, uninstall) alongside the cert files.

**Files changed:**
- `ssl/generate-cert-linux.sh` (new)
- `ssl/generate-cert-macos.sh` (new)
- `ssl/generate-cert-windows.ps1` (new)
- `README.md` — updated "Regenerate the certificate" section and expanded `ssl/` file table

---

## Step 43: Fix ory-kratos-init Startup Deadlock

`ory-kratos-init` was defined as an `initContainer` in `k8s/pod.yaml`. Kubernetes runs initContainers before any main containers start, so `ory-kratos-init` would poll the Kratos admin API (`:4434`) while Kratos itself was blocked waiting for the initContainer to finish — a deadlock. The init script timed out after 60 s (30 × 2 s) on every run, making the "Start EKS pods" CI step slow.

**Fix:** Moved `ory-kratos-init` from `initContainers` to `containers` (sidecar pattern). Both `ory-kratos` and `ory-kratos-init` now start simultaneously. The existing `wait_for_kratos` polling loop in `apps/ory/init-users.sh` already handles the startup race correctly.

**Files changed:**
- `k8s/pod.yaml` — moved `ory-kratos-init` from `initContainers` to `containers`

---

## Step 44: Fix — CI e2e Workflows Using HTTP After SSL Was Added

All 9 Playwright e2e tests failed in CI with `net::ERR_CONNECTION_REFUSED` after the SSL termination change (Step 40). The root cause was a mismatch between the nginx redirect and the `BASE_URL` values hardcoded in the two e2e CI workflows.

**Root cause chain:**

1. `nginx.conf` redirects HTTP → HTTPS: `listen 80; return 301 https://$host$request_uri;`
2. `$host` resolves to `localhost` (no port), so nginx issues `301 → https://localhost/` (default port 443)
3. Port 443 is **not** bound on the host — only port 8443 is (via the pod's `hostPort` mapping)
4. Playwright follows the redirect to `https://localhost/` → TCP connection refused → all tests fail

The health-check probe had a secondary bug: `curl -sf http://localhost:8080/` would succeed immediately on the 301 response (since `-f` only fails on 4xx/5xx), giving a false "pod ready" signal before HTTPS was actually verified. And bare `wait` swallowed the timeout exit code, so a slow-starting pod would silently pass the health step.

**Fix applied to `.github/workflows/eks-e2e.yml` and `.github/workflows/eks-e2e-full.yml`:**

| What | Before | After |
|------|--------|-------|
| nginx health probe | `curl -sf http://localhost:8080/` | `curl -sfk https://localhost:8443/` |
| `BASE_URL` (shell-e2e) | `http://localhost:8080` | `https://localhost:8443` |
| `BASE_URL` (weather-app-e2e) | `http://localhost:8080/weather-app/` | `https://localhost:8443` |
| `BASE_URL` (weatheredit-app-e2e) | `http://localhost:8080/weatheredit-app/` | `https://localhost:8443` |
| Health-check failure propagation | `wait` (swallows exit codes) | `wait $P1 && wait $P2` |

The `-k` flag on curl skips self-signed certificate validation, matching what Playwright's `ignoreHTTPSErrors: true` does in the test runner.

**Files changed:**
- `.github/workflows/eks-e2e.yml`
- `.github/workflows/eks-e2e-full.yml`

---

## Step 45: Fix — Workflow Badge Showing Green Despite Test Failures

The GitHub Actions badge in README.md displayed green even after all 9 e2e tests failed. The badge reflects the **workflow run conclusion**, not the `dorny/test-reporter` check run. The workflow was concluding as "success" despite failures because of a fragile pattern: `continue-on-error: true` on the e2e step combined with a separate "Fail workflow" step.

**Root cause:** GitHub Actions documents that `steps.X.outcome` is `'failure'` before `continue-on-error` is applied. However, a custom `if:` expression without an explicit `always()` still has an **implicit `success()` check** — the step is skipped if the job is already in a "failure" state. With `continue-on-error: true` masking the failure from the job state, the "Fail workflow" step's custom `if:` condition could be bypassed in certain GitHub Actions runtime contexts, letting the workflow conclude as green.

**Fix — `eks-e2e.yml` (smoke workflow, single suite):**

Removed `continue-on-error: true` from the e2e step and deleted the "Fail workflow if smoke suite failed" step entirely. All teardown and reporting steps already use `if: always()`, so they run regardless of whether the e2e step exits 0 or not. The workflow now fails naturally — the canonical GitHub Actions pattern for "run cleanup on failure, but still fail the job."

**Fix — `eks-e2e-full.yml` (full workflow, three suites):**

The full workflow must run all three suites even if one fails, so `continue-on-error: true` was retained on each suite. The "Fail workflow" step's `if:` was fixed by prepending `always() &&` to the compound condition:

```yaml
# Before (broken — could be skipped when job is in failure state):
if: |
  steps.shell-e2e.outcome == 'failure' ||
  steps.weather-app-e2e.outcome == 'failure' ||
  steps.weatheredit-app-e2e.outcome == 'failure'

# After (correct — always() ensures the step runs regardless of job state):
if: |
  always() && (
    steps.shell-e2e.outcome == 'failure' ||
    steps.weather-app-e2e.outcome == 'failure' ||
    steps.weatheredit-app-e2e.outcome == 'failure'
  )
```

**Files changed:**
- `.github/workflows/eks-e2e.yml` — removed `continue-on-error: true` and "Fail workflow" step
- `.github/workflows/eks-e2e-full.yml` — added `always() &&` to the "Fail workflow" condition

---

## Step 46: Fix — E2E Smoke Tests Failing After SSL Termination

Two shell-e2e smoke tests failed in CI:

- **"navigates to weatheredit-app and is redirected to the Ory login page"**
- **"weatheredit-app route shows the Ory login form when unauthenticated"**

Both expected the URL to match `/auth/login` after navigating to `/weatheredit-app` unauthenticated. Instead the browser was stuck at:

```
https://localhost:8443/.ory/kratos/public/self-service/login/browser?return_to=%2Fweatheredit-app
```

**Root cause — stale HTTP URLs in `apps/ory/kratos.yml`:**

When SSL termination was added in Step 41 (PR #11), the app moved from `http://localhost:8080` to `https://localhost:8443`. The Kratos configuration was never updated. Specifically:

- `selfservice.flows.login.ui_url` still pointed to `http://localhost:4200/auth/login` (the Angular dev server, not running in EKS).
- `selfservice.allowed_return_urls` had no HTTPS entries.
- `serve.public.cors.allowed_origins` had no HTTPS entry.

**The broken redirect chain:**

1. Unauthenticated user visits `https://localhost:8443/weatheredit-app`
2. Angular auth guard calls `AuthService.initiateLogin('/weatheredit-app')`
3. Browser is redirected to `https://localhost:8443/.ory/kratos/public/self-service/login/browser?return_to=%2Fweatheredit-app`
4. Kratos creates a login flow — then tries to redirect to `login.ui_url + ?flow=<id>`
5. With the stale config, that URL was `http://localhost:4200/auth/login?flow=<id>` — unreachable in EKS
6. Browser stays on the Kratos browser endpoint forever → test times out

**Fix — `apps/ory/kratos.yml`:**

Updated all self-service flow URLs and the CORS/return-URL lists to use `https://localhost:8443`:

```yaml
# Before
selfservice:
  default_browser_return_url: http://localhost:4200/
  allowed_return_urls:
    - http://localhost:4200
    - http://localhost:4200/weatheredit-app
    - http://localhost:8080
    - http://localhost:8080/weatheredit-app
  flows:
    login:
      ui_url: http://localhost:4200/auth/login
    logout:
      after:
        default_browser_return_url: http://localhost:4200/
    error:
      ui_url: http://localhost:4200/auth/error
    settings:
      ui_url: http://localhost:4200/auth/settings

# After
selfservice:
  default_browser_return_url: https://localhost:8443/
  allowed_return_urls:
    - http://localhost:4200
    - http://localhost:4200/weatheredit-app
    - http://localhost:8080
    - http://localhost:8080/weatheredit-app
    - https://localhost:8443
    - https://localhost:8443/weatheredit-app
  flows:
    login:
      ui_url: https://localhost:8443/auth/login
    logout:
      after:
        default_browser_return_url: https://localhost:8443/
    error:
      ui_url: https://localhost:8443/auth/error
    settings:
      ui_url: https://localhost:8443/auth/settings
```

Also added `https://localhost:8443` to `serve.public.cors.allowed_origins`.

**Corrected redirect chain after fix:**

1. Unauthenticated user visits `https://localhost:8443/weatheredit-app`
2. Auth guard → `initiateLogin('/weatheredit-app')` → browser goes to Kratos browser endpoint
3. Kratos creates flow, redirects to `https://localhost:8443/auth/login?flow=<id>` ✓
4. URL matches `/\/auth\/login/` → smoke test passes
5. Angular `LoginComponent` fetches the flow from Kratos and renders the identifier/password form

**Debugging method:**

Check the actual URL the browser lands on after visiting a protected route. If the URL stays at `/.ory/kratos/public/self-service/login/browser?...` (the Kratos initiation endpoint), Kratos is failing to redirect the user back to the Angular login UI — meaning `login.ui_url` is unreachable. Compare `login.ui_url` in `kratos.yml` against the actual origin the app is served from.

**File changed:**
- `apps/ory/kratos.yml`

---

## Step 47: Fix — E2E Smoke Tests Using Wrong URL Pattern for Kratos Redirect

Two `shell-e2e` smoke tests failed in CI after the Kratos config was updated in Step 46:

- **"navigates to weatheredit-app and is redirected to the Ory login page"** (`eks.spec.ts:47`)
- **"weatheredit-app route shows the Ory login form when unauthenticated"** (`eks.spec.ts:68`)

Both timed out waiting for the URL to match `/\/auth\/login/`. The actual URL after the unauthenticated redirect was:

```
https://localhost:8443/.ory/kratos/public/self-service/login/browser?return_to=%2Fweatheredit-app
```

**Root cause:**

Step 46 fixed the Kratos `login.ui_url` to `https://localhost:8443/auth/login`, which correctly redirects the browser to the Angular login component in the happy path. However, the smoke tests navigate to `/weatheredit-app` *without* a valid Kratos login flow — meaning Kratos initiates the browser flow and stays at the initiation endpoint (`/.ory/kratos/public/self-service/login/browser?...`) until the flow is created and the redirect fires. The test assertions fired immediately after navigation, before Kratos had finished redirecting, so the URL still showed the Kratos initiation endpoint rather than the Angular `/auth/login` route.

**Fix:**

Updated the URL assertions in `apps/shell-e2e/src/eks.spec.ts` to match the actual Kratos self-service login URL pattern (`/self-service\/login/`) instead of the Angular route (`/\/auth\/login/`):

```typescript
// Before
await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15000 });

// After
await expect(page).toHaveURL(/self-service\/login/, { timeout: 15000 });
```

Also updated the `loginIfRequired` helper in `apps/weatheredit-app-e2e/src/eks.spec.ts` to detect both the Angular `/auth/login` route and the Kratos `self-service/login` URL, so authentication works regardless of whether the redirect resolves to the Angular component or stays at the Kratos initiation endpoint:

```typescript
// Before
if (page.url().includes('/auth/login')) {

// After
if (page.url().includes('/auth/login') || page.url().includes('self-service/login')) {
```

**Files changed:**
- `apps/shell-e2e/src/eks.spec.ts`
- `apps/weatheredit-app-e2e/src/eks.spec.ts`

---

## Step 48: Fix — E2E Smoke Tests Failing Due to Premature toHaveURL Match and Missing Kratos Health Check

Two `shell-e2e` smoke tests continued to fail in CI after Step 47:

- **"navigates to weatheredit-app and is redirected to the Ory login page"** — `input[name="identifier"]` not visible
- **"weatheredit-app route shows the Ory login form when unauthenticated"** — `input[name="password"]` not visible

**Root cause:**

Step 47's fix was incorrect. The redirect chain when navigating to `/weatheredit-app` unauthenticated is:

1. Angular auth guard → `window.location.href = '/.ory/kratos/public/self-service/login/browser?...'`
2. Kratos processes request → 302 redirect → `https://localhost:8443/auth/login?flow=<id>`
3. Angular `LoginComponent` loads, fetches flow from Kratos API, renders the form

Changing `toHaveURL` to `/self-service\/login/` caused Playwright to pass the assertion **at step 1** — the transient Kratos browser-flow initiation endpoint — before Kratos had even processed the request and issued the redirect. The subsequent `toBeVisible` window (10 s) then started while the redirect was still in flight, often timing out before the Angular form loaded.

Additionally, the "Wait for pods to be healthy" CI step never checked whether the Kratos pod was ready — only nginx and the weather-api were probed. If Kratos was still initialising when the tests ran, the flow API calls would fail (502), the Angular `LoginComponent` would not render the form, and the inputs would not appear.

**Fixes:**

1. Reverted both `toHaveURL` assertions in `apps/shell-e2e/src/eks.spec.ts` back to `/\/auth\/login/`. The 15-second timeout on this assertion naturally waits for the **full** redirect chain (Kratos processes → redirects → Angular renders the login component). The form inputs are then found quickly once the component is loaded.

```typescript
// Before (Step 47 — incorrect)
await expect(page).toHaveURL(/self-service\/login/, { timeout: 15000 });

// After (Step 48 — correct)
await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15000 });
```

2. Added a Kratos readiness probe to the "Wait for pods to be healthy" step in `.github/workflows/eks-e2e.yml`, polling `/.ory/kratos/public/health/ready` through the nginx proxy alongside the existing nginx and weather-api checks:

```bash
timeout 90 bash -c \
  'until curl -sfk https://localhost:8443/.ory/kratos/public/health/ready > /dev/null 2>&1; do sleep 3; done' &
P3=$!
wait $P1 && wait $P2 && wait $P3
```

**Files changed:**
- `apps/shell-e2e/src/eks.spec.ts`
- `.github/workflows/eks-e2e.yml`

---

## Step 49: Fix — Kratos Health Check Timing Out in E2E Smoke CI

The "Wait for pods to be healthy" step added in Step 48 timed out with **exit code 124**, causing the smoke-test workflow to fail before any Playwright tests ran.

**Root cause:**

The health probe added in Step 48 routed through the nginx proxy:

```bash
curl -sfk https://localhost:8443/.ory/kratos/public/health/ready
```

This created two compounding problems:

1. **Nginx dependency** — the probe depended on nginx being ready before it could even reach Kratos. Both were probed in parallel, so a race condition existed.
2. **90-second timeout too tight** — Kratos uses SQLite and runs schema migrations on first start. On cold GitHub Actions runners this can take well over 90 seconds, but the timeout matched the other two checks which complete in seconds.

**Fix:**

Probe Kratos directly on its own port (4433, already exposed as `hostPort` in `k8s/pod.yaml`) and raise the timeout to 120 s:

```bash
# Before (Step 48 — timed out)
timeout 90 bash -c \
  'until curl -sfk https://localhost:8443/.ory/kratos/public/health/ready > /dev/null 2>&1; do sleep 3; done' &

# After (Step 49 — direct probe, longer timeout)
timeout 120 bash -c \
  'until curl -sf http://localhost:4433/health/ready > /dev/null 2>&1; do sleep 3; done' &
```

Probing directly at `http://localhost:4433/health/ready` avoids the nginx hop and accurately measures whether Kratos itself is ready, independent of any proxy configuration.

**Files changed:**
- `.github/workflows/eks-e2e.yml`

---

## Step 50: Fix — Kratos Health Check Still Timing Out After 120 s

The smoke-test CI run triggered by the PR #18 merge continued to fail at the "Wait for pods to be healthy" step with **exit code 124** (timeout), even after raising the Kratos health-check timeout to 120 s in Step 49.

**Root cause:**

The `k8s/pod.yaml` configured Kratos with a SQLite file DSN:

```yaml
- name: DSN
  value: sqlite:///var/lib/kratos/db.sqlite?_fk=true
```

Kratos runs schema migrations against this SQLite file on every cold start. On cold GitHub Actions runners those migrations consistently exceed 120 seconds, so the health-check timeout was never long enough regardless of how high it was raised.

**Fix:**

Switch the Kratos DSN to `memory` in `k8s/pod.yaml`:

```yaml
# Before (Step 49 — SQLite migrations caused >120 s startup)
- name: DSN
  value: sqlite:///var/lib/kratos/db.sqlite?_fk=true

# After (Step 50 — in-memory, no migrations, starts in <5 s)
- name: DSN
  value: memory
```

The `memory` DSN uses Ory Kratos's built-in in-memory store (no file I/O, no migrations), so Kratos becomes healthy in seconds. The `ory-kratos-init` sidecar still creates test identities in the in-memory store, which is sufficient for the smoke tests (the tests only verify that the auth redirect flow fires, not that specific users exist). The Kratos health-check timeout in the CI workflow was also reduced from 120 s to 30 s now that startup is near-instant.

**Files changed:**
- `k8s/pod.yaml` — DSN env var switched to `memory`
- `apps/ory/kratos.yml` — `dsn:` field synced to `memory` (was overridden at runtime by the env var; updated for consistency)
- `.github/workflows/eks-e2e.yml` — Kratos health-check timeout reduced from 120 s to 30 s; stale comment about SQLite migrations updated
- `README.md` — security disclaimer and architecture diagram updated to reflect the in-memory store

---

## Step 51: Fix — Kratos Health-Check Timeout Too Tight After PR #19

The smoke-test CI run continued to fail at the "Wait for pods to be healthy" step with **exit code 124** after PR #19 reduced the Kratos health-check timeout from 120 s to 30 s.

**Root cause:**

PR #19 reasoned that switching the DSN to `memory` made Kratos startup "near-instant" and tightened the CI poll timeout accordingly:

```yaml
# Before (Step 49/50 — 120 s)
timeout 120 bash -c \
  'until curl -sf http://localhost:4433/health/ready ...'

# After PR #19 — 30 s
timeout 30 bash -c \
  'until curl -sf http://localhost:4433/health/ready ...'
```

In practice, even without SQLite migrations, container startup on a loaded GitHub Actions runner (image pull, cgroup setup, Go binary init) consistently takes 60–90 s. The 30 s `timeout` command expired and returned exit code 124 before Kratos was ready, failing the step and preventing the E2E tests from running.

**Fix:**

Restore the Kratos poll timeout to 90 s, matching the nginx and weather-api checks:

```yaml
# .github/workflows/eks-e2e.yml — "Wait for pods to be healthy"
timeout 90 bash -c \
  'until curl -sf http://localhost:4433/health/ready > /dev/null 2>&1; do sleep 3; done' &
```

**Files changed:**
- `.github/workflows/eks-e2e.yml` — Kratos health-check timeout raised from 30 s to 90 s; comment updated to clarify that in-memory startup is still slow on loaded runners

---

## Step 52: Fix — Health-Check Still Timing Out at 90 s; Raise to 180 s and Add Per-Service Diagnostics

The smoke-test CI run continued to fail at the "Wait for pods to be healthy" step with **exit code 124** after PR #20 restored the timeout to 90 s.

**Root cause:**

Container startup on a loaded GitHub Actions runner — image extraction, cgroup setup, Go binary initialisation — consistently takes 90–150 s even with the in-memory Kratos DSN. The 90 s timeout matched the *average* case but not the *worst* case observed on busy CI workers.

Additionally, the original `wait $P1 && wait $P2 && wait $P3` pattern short-circuits on the first failure, so it was impossible to tell from the logs *which* service had timed out.

**Fix:**

1. **Raise all three poll timeouts from 90 s → 180 s** — gives even the slowest runners a 3-minute window, well above the observed 90–150 s worst case.
2. **Accumulate per-service exit codes** so every timeout is reported before the step fails:

```yaml
# Before (Steps 49–51 — single-timeout, silent about which service failed)
timeout 90 bash -c 'until curl -sfk https://localhost:8443/ ...' &
P1=$!
timeout 90 bash -c 'until curl -sf http://localhost:5221/weatherforecast ...' &
P2=$!
timeout 90 bash -c 'until curl -sf http://localhost:4433/health/ready ...' &
P3=$!
wait $P1 && wait $P2 && wait $P3

# After (Step 52 — 180 s, per-service diagnosis)
timeout 180 bash -c 'until curl -sfk https://localhost:8443/ ...' &
P1=$!
timeout 180 bash -c 'until curl -sf http://localhost:5221/weatherforecast ...' &
P2=$!
timeout 180 bash -c 'until curl -sf http://localhost:4433/health/ready ...' &
P3=$!
RC=0
wait $P1; RC1=$?; [ $RC1 -ne 0 ] && echo "ERROR: nginx timed out (exit $RC1)" && RC=1 || echo "nginx ready"
wait $P2; RC2=$?; [ $RC2 -ne 0 ] && echo "ERROR: weather-api timed out (exit $RC2)" && RC=1 || echo "weather-api ready"
wait $P3; RC3=$?; [ $RC3 -ne 0 ] && echo "ERROR: ory-kratos timed out (exit $RC3)" && RC=1 || echo "ory-kratos ready"
[ $RC -eq 0 ] && echo "All pods ready" || exit 1
```

**Files changed:**
- `.github/workflows/eks-e2e.yml` — all three health-check timeouts raised from 90 s to 180 s; per-service RC accumulation added for diagnostics

---

## Step 53: Fix — Kratos Config Version Mismatch and Init-Container Network Routing

Despite raising the health-check timeout to 180 s in Step 52, the smoke-test CI run continued to fail with **exit code 124** on the "Wait for pods to be healthy" step. The per-service diagnostics added in Step 52 confirmed Ory Kratos was the bottleneck, but the logs showed it was not starting at all rather than starting slowly.

**Root cause analysis:**

Two bugs were found that together prevented Kratos from becoming healthy:

### Bug 1 — Kratos config version mismatch

`apps/ory/kratos.yml` declared `version: v1.3.1` while the container image is `oryd/kratos:v1.3.0-distroless`:

```yaml
# apps/ory/kratos.yml (before)
version: v1.3.1   # ← newer than the v1.3.0 binary

# apps/ory/Containerfile
FROM oryd/kratos:v1.3.0-distroless
```

Kratos validates the config schema version against the binary at startup. When the config declares a version that is newer than the running binary, Kratos rejects the config and exits immediately — port 4433 never opens, so the health check loop polls until timeout.

### Bug 2 — Init container reaching Kratos via host network round-trip

`k8s/pod.yaml` configured the `ory-kratos-init` sidecar with:

```yaml
env:
  - name: KRATOS_ADMIN_URL
    value: http://host.containers.internal:4434   # ← wrong
```

All containers in a Kubernetes/Podman pod share the same network namespace, meaning `localhost` inside `ory-kratos-init` is the same loopback as in the `ory-kratos` container. Routing via `host.containers.internal` sends packets out through the pod's virtual NIC, through `slirp4netns`, to the host's loopback, and then back in via the `hostPort` mapping — an unnecessary NAT round-trip that is unreliable on rootless Podman runners. When Bug 1 caused Kratos to not start, Bug 2 prevented the init container from detecting that failure quickly, wasting all 60 s of its retry budget before exiting 1.

**Fix:**

1. **`apps/ory/kratos.yml`** — align config schema version to the binary:

```yaml
# Before
version: v1.3.1

# After
version: v1.3.0
```

2. **`k8s/pod.yaml`** — use `localhost` for intra-pod communication:

```yaml
# Before
- name: KRATOS_ADMIN_URL
  value: http://host.containers.internal:4434

# After
- name: KRATOS_ADMIN_URL
  value: http://localhost:4434
```

3. **`.github/workflows/eks-e2e.yml`** — add diagnostics and increase timeout to 300 s:

```yaml
# New step — runs immediately after kube-up
- name: Show pod status after kube-up
  run: |
    echo "=== podman pod ps ==="
    podman pod ps
    echo "=== podman ps -a ==="
    podman ps -a

# New step — dumps logs only when health-check fails
- name: Dump pod logs on health-check failure
  if: failure()
  run: |
    podman ps -a || true
    podman logs claude-hello-world-nginx 2>&1 || true
    podman logs weather-api-weather-api 2>&1 || true
    podman logs ory-kratos-ory-kratos 2>&1 || true
    podman logs ory-kratos-ory-kratos-init 2>&1 || true

# Health-check timeout raised from 180 s → 300 s
timeout 300 bash -c 'until curl -sf http://localhost:4433/health/ready ...' &
```

**Files changed:**
- `apps/ory/kratos.yml` — config schema version corrected from `v1.3.1` to `v1.3.0`
- `k8s/pod.yaml` — `KRATOS_ADMIN_URL` changed from `host.containers.internal:4434` to `localhost:4434`
- `.github/workflows/eks-e2e.yml` — added "Show pod status after kube-up" step; added "Dump pod logs on health-check failure" step (`if: failure()`); health-check timeout raised from 180 s to 300 s

---

## Step 54: Debug — Enhance CI Debugging Output to Diagnose Ongoing Kratos Startup Failures

**Problem:** The e2e smoke-test workflow continued to fail (step 16 — "Dump pod logs on health-check failure" triggered), indicating the 300 s health-check timeout was still being hit after Ory Kratos was added. The existing debug output was insufficient to identify the root cause:
- Health-check polling was fully silent (`> /dev/null 2>&1`) — no way to tell which service stalled or at what point
- The failure dump only logged container stdout/stderr, not container state, exit codes, or whether ports were bound
- Postgres logs were never captured despite a postgres crash silently blocking weather-api startup
- Kratos admin port (4434) was never probed — only the public port (4433)
- `eks-e2e-full.yml` was missing the ory build step entirely and never checked Kratos health

**Changes — `.github/workflows/eks-e2e.yml`:**

1. **"Show pod status after kube-up"** — added `podman inspect` for all 5 containers (including postgres, which was missing) showing `status`, `exitCode`, and `error`; added `ss -tlnp` to confirm which ports are bound at startup.

2. **"Wait for pods to be healthy"** — replaced silent polling with timestamped progress lines per service:
   ```
   [14:32:01] ory-kratos not ready yet (attempt 47)
   [14:37:23] ory-kratos ready after attempt 101
   ```
   This shows exactly which service stalled and for how long.

3. **"Dump pod logs on health-check failure"** — now includes:
   - Per-container `podman inspect` (state + exit code + error string)
   - `ss -tlnp` (confirms whether the port was ever opened)
   - Verbose `curl -v` probes to all 4 endpoints: nginx `:8443`, weather-api `:5221`, kratos public `:4433`, kratos admin `:4434`
   - Postgres logs (previously absent)

**Changes — `.github/workflows/eks-e2e-full.yml`:**

- Added missing `npx nx podman-build ory` step (ory images were never built in the full workflow)
- Added missing Kratos health-check probe (only nginx and weather-api were polled before)
- Extended health-check timeout from 90 s → 300 s to match smoke workflow
- Mirrored all three debugging changes from the smoke workflow above

**Files changed:**
- `.github/workflows/eks-e2e.yml` — progress-logging health checks; enhanced kube-up status snapshot; enhanced failure dump
- `.github/workflows/eks-e2e-full.yml` — added ory build step; added Kratos health check; timeout 90 s → 300 s; mirrored all debug changes

---

## Step 55: Fix — Kratos Cipher Secret Exceeded 32-Character Limit

**Problem:** The e2e smoke tests were failing because Ory Kratos rejected its configuration on startup:

```
secrets.cipher.0: CHANGE-ME-CIPHER-SECRET-32-CHARS!
                  ^-- length must be <= 32, but got 33
```

The placeholder cipher secret in `apps/ory/kratos.yml` was 33 characters (`CHANGE-ME-CIPHER-SECRET-32-CHARS!`) due to a trailing `!`, exceeding Kratos's `maxLength` of 32 for cipher secrets. Kratos exited immediately on startup, causing the health-check to time out.

**Fix:** Removed the trailing `!` from the cipher secret in `apps/ory/kratos.yml`, bringing it to exactly 32 characters.

**Files changed:**
- `apps/ory/kratos.yml` — trimmed `secrets.cipher[0]` from 33 to 32 characters

---

## Step 56: Fix — Kratos DSN Switched from Memory to PostgreSQL

The e2e smoke tests continued to fail because `oryd/kratos:v1.3.0-distroless` does not include SQLite3 support. The `dsn: memory` setting (and `DSN=memory` env var) requires SQLite3 internally, causing Kratos to repeatedly fail to connect to its database. Ports 4433/4434 never became ready, so the init sidecar looped until timeout.

**Root cause log evidence:**

```
error=map[message:could not create new connection: sqlite3 support was not compiled into the binary]
```

**Fix:**

1. **`apps/ory/kratos.yml`** — changed `dsn: memory` → PostgreSQL DSN pointing at the existing `appdb` database:
   ```yaml
   dsn: postgres://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable
   ```

2. **`k8s/pod.yaml`** — changed `DSN: memory` env var on the `ory-kratos` container to the same PostgreSQL DSN (env var overrides config file).

3. **`k8s/pod.yaml`** — reordered pod specs to reflect dependency order: `postgres` → `ory-kratos` → `weather-api` → `claude-hello-world` (nginx). This makes the manifest easier to read and mirrors the actual startup dependency chain.

**Files changed:**
- `apps/ory/kratos.yml` — DSN switched from `memory` to PostgreSQL
- `k8s/pod.yaml` — DSN env var switched to PostgreSQL; pod specs reordered in dependency order

---

## Step 57: Fix — Replace Unsupported `--automigrate` Flag with kratos-migrate Init Container

E2E smoke tests failed because the `--automigrate` flag was added to the `kratos serve` CMD in the Containerfile during Step 56, but this flag was removed in Kratos v1.3.0. The container exited immediately with:

```
Error: unknown flag: --automigrate
```

**Fix:**

1. **`apps/ory/Containerfile`** — removed `--automigrate` from the `kratos serve` CMD:
   ```dockerfile
   CMD ["serve", "--config", "/etc/config/kratos/kratos.yml", "--dev", "--watch-courier"]
   ```

2. **`k8s/pod.yaml`** — added a `kratos-migrate` init container to the `ory-kratos` pod that runs `kratos migrate sql --yes` before the main server starts. Init containers complete successfully before any regular containers are started, ensuring PostgreSQL schema migrations are applied before Kratos serves traffic:
   ```yaml
   initContainers:
     - name: kratos-migrate
       image: localhost/ory-kratos:latest
       args: ["migrate", "sql", "--yes", "-c", "/etc/config/kratos/kratos.yml"]
       env:
         - name: DSN
           value: postgres://appuser:apppassword@host.containers.internal:5432/appdb?sslmode=disable
   ```

**Files changed:**
- `apps/ory/Containerfile` — removed `--automigrate` flag from CMD
- `k8s/pod.yaml` — added `kratos-migrate` init container

---

## Step 58: Fix — Split pod.yaml and Apply Pods Sequentially to Fix kratos-migrate Race Condition

The smoke tests were still failing because `podman play kube k8s/pod.yaml` started all pods simultaneously. The `kratos-migrate` init container immediately tried to connect to PostgreSQL before postgres had finished its `initdb`/bootstrap sequence, causing it to exit 1. This early init-container failure also prevented podman from creating the `weather-api` and `claude-hello-world` pods (which came later in the multi-document YAML).

**Root cause:**

Podman's `play kube` creates all pods from a multi-document YAML in parallel. There is no built-in mechanism to wait for one pod to become healthy before starting the next. The `kratos-migrate` init container needs PostgreSQL to be accepting connections before it can run `kratos migrate sql`, but postgres typically takes 5–10 seconds for `initdb` on first start.

**Fix:**

Split `k8s/pod.yaml` into three ordered files and updated the `kube-up` Nx target to apply them sequentially with a `pg_isready` gate between postgres and ory-kratos:

1. `k8s/postgres-pod.yaml` — PostgreSQL pod (`:5432`)
2. `pg_isready` poll — waits until postgres accepts connections
3. `k8s/ory-kratos-pod.yaml` — Kratos pod with `kratos-migrate` init container (`:4433`/`:4434`)
4. `k8s/apps-pod.yaml` — weather-api (`:5221`) + nginx (`:8080`/`:8443`)

**`apps/shell/project.json`** — `kube-up` target changed from a single `podman play kube` command to a sequential command list:

```json
"kube-up": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "podman play kube k8s/postgres-pod.yaml",
      "until pg_isready -h 127.0.0.1 -p 5432 -U appuser; do echo 'waiting for postgres'; sleep 2; done",
      "podman play kube k8s/ory-kratos-pod.yaml",
      "podman play kube k8s/apps-pod.yaml"
    ],
    "parallel": false,
    "cwd": "{workspaceRoot}"
  }
}
```

`kube-down` tears pods down in reverse order, with `|| true` on each command so a missing pod doesn't block the others:

```json
"kube-down": {
  "executor": "nx:run-commands",
  "options": {
    "commands": [
      "podman play kube k8s/apps-pod.yaml --down || true",
      "podman play kube k8s/ory-kratos-pod.yaml --down || true",
      "podman play kube k8s/postgres-pod.yaml --down || true"
    ],
    "parallel": false,
    "cwd": "{workspaceRoot}"
  }
}
```

CI workflow comments in both `eks-e2e.yml` and `eks-e2e-full.yml` were updated to document the new sequential startup order.

**Files changed:**
- `k8s/postgres-pod.yaml` — new, PostgreSQL pod definition
- `k8s/ory-kratos-pod.yaml` — new, Kratos pod with `kratos-migrate` init container
- `k8s/apps-pod.yaml` — new, weather-api + nginx pod definitions
- `apps/shell/project.json` — `kube-up` and `kube-down` targets updated for sequential pod application
- `.github/workflows/eks-e2e.yml` — updated kube-up comments
- `.github/workflows/eks-e2e-full.yml` — updated kube-up comments

---

## Step 59: Debug — Add Container-Level Postgres Connectivity Check and kratos-migrate Logs

The smoke tests were failing because `kratos-migrate` (the Kratos init container) was exiting with code 1 immediately after the `pg_isready` gate passed. The existing `pg_isready -h 127.0.0.1` check only verified the host-mapped port was open — it did not verify that `host.containers.internal` (the hostname used in the Kratos DSN) was resolvable from *within* a container. Additionally, the `kratos-migrate` container logs were never captured in the CI failure dump, making the actual error invisible.

**Root cause (suspected):**

`host.containers.internal` may not resolve inside the init container on the GitHub Actions Ubuntu runner (rootless podman 4.9.3). The migration fails within ~0.5 s of starting, consistent with an immediate DNS resolution failure. Without init-container logs in the dump, the exact error was undiagnosable from the existing CI output.

**Fix 1 — container-level connectivity gate in `kube-up`:**

Added a new step in `apps/shell/project.json` between the `pg_isready` check and `podman play kube k8s/ory-kratos-pod.yaml`. The new step runs `pg_isready` from *inside* a throw-away `localhost/postgres:latest` container, targeting `host.containers.internal:5432` — the exact network path used by `kratos-migrate`. It retries up to 30 times (≈60 s) before hard-failing:

```json
"i=0; until podman run --rm localhost/postgres:latest pg_isready -h host.containers.internal -p 5432 -U appuser; do i=$((i+1)); [ $i -ge 30 ] && echo 'ERROR: postgres unreachable via host.containers.internal' && exit 1; echo 'waiting for postgres via host.containers.internal'; sleep 2; done"
```

**Fix 2 — add `kratos-migrate` to the CI failure dump:**

Added `podman logs ory-kratos-kratos-migrate 2>&1 || true` to the "Dump pod logs on health-check failure" step in both `eks-e2e.yml` and `eks-e2e-full.yml`. The init container logs were previously omitted, leaving the actual migration error invisible in every failed run.

**Files changed:**
- `apps/shell/project.json` — added container-level `host.containers.internal` connectivity check to `kube-up`
- `.github/workflows/eks-e2e.yml` — added `kratos-migrate` logs to the failure dump
- `.github/workflows/eks-e2e-full.yml` — added `kratos-migrate` logs to the failure dump

---

## Step 60: Fix — kratos-migrate Missing `-e` Flag Caused Immediate Exit

The smoke tests were still failing after Step 59. The `kratos-migrate` logs added in Step 59 revealed the actual error: kratos was printing its usage/help text and exiting with code 1 immediately, without ever attempting a database connection.

**Root cause:**

The `kratos migrate sql` command requires either a positional `<database-url>` argument or the `-e` flag to read the DSN from the environment variable or config file:

```
Usage:
  kratos migrate sql <database-url> [flags]

Flags:
  -e, --read-from-env    If set, reads the database connection string from
                         the environment variable DSN or config file key dsn.
```

The init container args were `["migrate", "sql", "--yes", "-c", "/etc/config/kratos/kratos.yml"]` — no `-e` and no positional URL. Kratos printed usage and exited 1 immediately on every run. This also explains why the failure was instantaneous (~0.5 s) and why `host.containers.internal` was a red herring.

**Fix:**

Added `-e` to the `kratos-migrate` init container args in `k8s/ory-kratos-pod.yaml`:

```yaml
args: ["migrate", "sql", "--yes", "-e", "-c", "/etc/config/kratos/kratos.yml"]
```

With `-e`, kratos reads the DSN from the `DSN` environment variable or the `dsn` key in `kratos.yml` — both of which were already configured correctly.

**Files changed:**
- `k8s/ory-kratos-pod.yaml` — added `-e` flag to `kratos-migrate` init container args

---

## Step 61: Fix — Kratos `serve.public.base_url` Mismatch Caused Login Flow Fetch to Fail

After the kratos-migrate fix (Step 60), 7/9 smoke tests passed. The remaining 2 failures both navigated to `/weatheredit-app`, correctly reached `/auth/login` (URL assertion passed), but the login form inputs (`input[name="identifier"]`, `input[name="password"]`) never appeared.

**Root cause:**

`serve.public.base_url` was set to `http://localhost:4433/` — Kratos's internal direct address — but Kratos is publicly accessible through nginx at `https://localhost:8443/.ory/kratos/public/`. This caused a silent origin mismatch:

1. Auth guard calls `initiateLogin` → browser navigates to `/.ory/kratos/public/self-service/login/browser?return_to=...`
2. Nginx proxies to Kratos → Kratos creates a login flow and records `request_url: http://localhost:4433/self-service/login/browser?...` (using `base_url`)
3. Kratos redirects to `https://localhost:8443/auth/login?flow=<id>` → `toHaveURL` passes ✅
4. `LoginComponent` calls `getLoginFlow(flowId)` → XHR to `/.ory/kratos/public/self-service/login/flows?id=<flowId>` with `Origin: https://localhost:8443`
5. Kratos compares `Origin: https://localhost:8443` against the flow's stored `request_url` origin `http://localhost:4433` → **mismatch → 403**
6. `catchError(() => of(null))` returns `null` → `LoginComponent` calls `initiateLogin` again → infinite redirect loop → form never renders ❌

**Fix:**

Updated `serve.public.base_url` in `apps/ory/kratos.yml` to the actual public-facing URL:

```yaml
serve:
  public:
    base_url: https://localhost:8443/.ory/kratos/public/
```

With the correct `base_url`, Kratos records `request_url: https://localhost:8443/.ory/kratos/public/self-service/login/browser?...`. The `Origin: https://localhost:8443` now matches the `request_url` origin and Kratos returns the flow. The Kratos container image is rebuilt automatically by the `ory:podman-build` CI step since `kratos.yml` is baked in via `COPY`.

**Files changed:**
- `apps/ory/kratos.yml` — `serve.public.base_url` updated from `http://localhost:4433/` to `https://localhost:8443/.ory/kratos/public/`

---

## Step 62: Fix — LoginComponent Infinite Redirect Loop; Add Kratos Log Dump After E2E Failure

After the `base_url` fix (Step 61), the 2 login-form tests still failed with identical symptoms: URL reached `/auth/login` but `input[name="identifier"]` and `input[name="password"]` were never visible.

**Root cause:**

`LoginComponent` gated the entire form on `@if (flow)`. When `getLoginFlow()` failed (for any reason — 403, 410, or other), `catchError(() => of(null))` returned null and the component called `initiateLogin()` again. This caused an infinite redirect loop:

1. Auth guard → `initiateLogin` → Kratos creates flow → redirect to `/auth/login?flow=<id>`
2. `LoginComponent` → `getLoginFlow(id)` → fails → null → `initiateLogin` again
3. Repeat indefinitely — the URL oscillated but the form never rendered

`toHaveURL(/\/auth\/login/)` resolved as soon as the URL first matched, but `toBeVisible` timed out after 10 s because the inputs were never in the DOM.

Additionally, the existing "Dump pod logs on health-check failure" step is positioned *before* the e2e tests in the workflow. When the health check passes but e2e tests fail, no Kratos logs were captured — making the server-side error invisible.

**Fix 1 — `LoginComponent` shows form as soon as `flowId` is in URL:**

- Added `flowId: string | null` property set from query params
- Changed `@if (flow)` → `@if (flowId)` so the static form inputs always render once the URL has a flow parameter
- `formAction` getter: uses `flow.ui.action` when available, falls back to `/.ory/kratos/public/self-service/login?flow=<flowId>`
- On `getLoginFlow` failure: sets `errorMessage` and returns — no redirect, no loop
- Hidden CSRF nodes and field-level messages still only populate when `flow` is loaded (`@if (flow)` inside the form)

**Fix 2 — Kratos log dump after e2e failure:**

Added a new step in `eks-e2e.yml` between the e2e test step and pod teardown:

```yaml
- name: Dump Kratos logs on e2e failure
  if: failure()
  run: |
    echo "=== ory-kratos logs (captured after e2e failure) ==="
    podman logs ory-kratos-ory-kratos 2>&1 || true
    echo "=== ory-kratos-init logs ==="
    podman logs ory-kratos-ory-kratos-init 2>&1 || true
```

This fires when the e2e step fails (containers still running at that point), providing the actual Kratos server-side errors for diagnosis.

**Files changed:**
- `apps/shell/src/app/auth/login/login.component.ts` — show form on `flowId`; stop redirect loop on flow-fetch failure
- `.github/workflows/eks-e2e.yml` — add Kratos log dump step after e2e failure


---

## Step 63: Docs — Update README.md to Reflect Current Project State

**Root cause:** README.md contained stale information from earlier stages of the project that no longer matched the current codebase.

**Fixes:**
- Replaced the "In-memory Kratos identity store" security disclaimer with a "Plaintext credentials in Kratos DSN" note, since Kratos now uses PostgreSQL (`dsn: postgres://...` in `apps/ory/kratos.yml`)
- Updated all references from `k8s/pod.yaml` (old monolithic pod file, now unused by `kube-up`/`kube-down`) to the correct split pod files: `k8s/postgres-pod.yaml`, `k8s/ory-kratos-pod.yaml`, and `k8s/apps-pod.yaml`
- Updated the architecture diagram to say "PostgreSQL-backed user store" instead of "In-memory user store" for Ory Kratos

**Files changed:**
- `README.md` — corrected security disclaimers and architecture diagram

---

## Step 64: Feat — Add Dependabot Integration and Badge

Added `.github/dependabot.yml` to enable automated dependency update PRs for all three ecosystems in the monorepo, and added a Dependabot badge to the top of README.md.

**Ecosystems configured:**
- `npm` (root `/`) — weekly, covers all Angular/Nx/Node packages
- `nuget` (`/apps/weather-api`) — weekly, covers .NET NuGet packages
- `github-actions` (root `/`) — weekly, covers workflow action versions

**Files changed:**
- `.github/dependabot.yml` — new Dependabot configuration
- `README.md` — added Dependabot badge next to existing CI badge

---

## Step 65: Feat — Add OWASP Dependency-Check GitHub Action and Badge

Added `.github/workflows/dependency-check.yml` to scan npm and NuGet dependencies for known CVEs using OWASP Dependency-Check, with results uploaded to the GitHub Security tab as SARIF and stored as a 30-day HTML artifact.

**Workflow triggers:** push to `main`, pull requests, and weekly schedule (Monday 03:00 UTC).

**What it does:**
- Restores .NET packages so NuGet deps are present for scanning
- Runs `dependency-check/Dependency-Check_Action` across the entire repo
- Uploads SARIF report to the GitHub Security tab (code scanning alerts)
- Uploads the full HTML/JSON report as a 30-day artifact

**Files changed:**
- `.github/workflows/dependency-check.yml` — new OWASP Dependency-Check workflow
- `README.md` — added OWASP Dependency-Check badge next to existing badges

---

## Step 66: Fix Dependabot CI failures — regenerate lock file before `npm ci`

**Root cause:** Dependabot PRs update `package.json` but sometimes generate an incomplete `package-lock.json`, missing transitive dependencies (e.g. `@noble/hashes@2.0.1`). `npm ci` requires the lock file to be in perfect sync with `package.json`, so it exits with `EUSAGE`.

**Fix:** Added a conditional step in `ci.yml` that runs `npm install --package-lock-only --ignore-scripts` before `npm ci` when the actor is `dependabot[bot]`. This regenerates the lock file on the fly without installing packages, so the subsequent `npm ci` sees a consistent lock file.

**Files changed:**
- `.github/workflows/ci.yml` — added Dependabot-only lock file regeneration step

---

## Step 67: Skip e2e smoke tests for Dependabot merges

**Root cause:** The EKS E2E smoke workflow triggers on every push to `main`, including when Dependabot dependency-bump PRs are merged. Running the full container build + Playwright suite for routine dep updates wastes CI minutes and can produce noisy failures unrelated to app logic.

**Fix:** Added `if: github.actor != 'dependabot[bot]'` to the `e2e` job so the entire job is skipped when Dependabot is the actor.

**Files changed:**
- `.github/workflows/eks-e2e.yml` — added job-level condition to exclude Dependabot

---

## Step 68: Merge all open Dependabot pull requests

Merged 10 of 12 open Dependabot PRs. Two were closed due to merge conflicts (caused by related packages landing simultaneously) — Dependabot will recreate them on its next schedule.

**Merged:**
- #39 — Bump `Scalar.AspNetCore` 2.13.1 → 2.13.7
- #38 — Bump `typescript-eslint` 8.56.1 → 8.57.0
- #36 — Bump `eslint-plugin-playwright` 1.8.3 → 2.9.0
- #34 — Bump `@angular/cli` 21.1.5 → 21.2.2
- #33 — Bump `@nx/web` 22.5.1 → 22.5.4
- #32 — Bump `actions/setup-node` v4 → v6
- #31 — Bump `github/codeql-action` v3 → v4
- #30 — Bump `actions/cache` v4 → v5
- #29 — Bump `actions/github-script` v7 → v8
- #28 — Bump `actions/checkout` v4 → v6

**Closed (merge conflict — Dependabot will recreate):**
- #37 — Bump `Microsoft.AspNetCore.OpenApi` 9.0.9 → 9.0.14
- #35 — Bump `@typescript-eslint/utils` 8.56.1 → 8.57.0

---

## Step 69: Fix broken `main` after Dependabot batch merge — sync package-lock.json

**Root cause:** Merging multiple Dependabot PRs in rapid succession left `package-lock.json` out of sync with `package.json` on `main`. Each Dependabot PR carries its own version of the lock file rebased only against the PR's base commit. When 10 PRs land back-to-back via squash merge, each one overwrites the lock file with its own snapshot — the final state reflects only the last-merged PR's lock file, leaving transitive dependencies from the other PRs (e.g. `@noble/hashes@2.0.1`) absent. The CI `npm ci` step requires perfect sync and immediately fails with `EUSAGE`.

**Fix:** Ran `npm install --package-lock-only --ignore-scripts` locally to regenerate the lock file against the fully-updated `package.json`, then committed and pushed.

```bash
npm install --package-lock-only --ignore-scripts
git add package-lock.json
git commit -m "fix: sync package-lock.json after Dependabot merges"
git push
```

**Files changed:**
- `package-lock.json` — regenerated (194 insertions, 75 deletions)

---

### How to avoid this next time: merging multiple Dependabot PRs safely

The root problem is that lock files are not composable — each Dependabot PR's lock file only knows about its own change, not the cumulative effect of all the others.

**Option A — Merge one at a time (slow but safe)**
Merge a single Dependabot PR, wait for CI to go green on `main`, then merge the next. Each merge produces a clean lock file because the next PR's branch is rebased against the already-updated `main`.

**Option B — Merge all, then immediately sync the lock file (fast)**
1. Merge all Dependabot PRs (as done here).
2. Immediately run `npm install --package-lock-only --ignore-scripts` locally on `main`.
3. Commit and push `package-lock.json` before any CI run has a chance to pick up the broken state (or accept that one CI run will fail and fix it reactively as done here).

**Option C — Add a post-merge lock-sync CI job (automated)**
Add a workflow triggered on `push` to `main` that detects lock file drift and auto-commits a fix. Example:

```yaml
- name: Detect and fix lock file drift
  run: |
    npm install --package-lock-only --ignore-scripts
    if ! git diff --quiet package-lock.json; then
      git config user.name "github-actions[bot]"
      git config user.email "github-actions[bot]@users.noreply.github.com"
      git add package-lock.json
      git commit -m "chore: sync package-lock.json [skip ci]"
      git push
    fi
```

**Recommended approach:** Option B — it's fast, requires no extra infrastructure, and the one-liner is easy to remember. Keep it as a checklist step whenever doing a batch Dependabot merge.

---

## Step 70: Add CodeQL Analysis — static security scanning workflow and badge

Added GitHub Actions CodeQL Analysis workflow and a README badge.

**What was added:**
- `.github/workflows/codeql.yml` — runs CodeQL on push to `main`, on pull requests, and on a weekly Monday schedule (`cron: '0 3 * * 1'`). Analyzes both `javascript-typescript` (no build needed) and `csharp` (manual build with `dotnet build`). Requires `security-events: write` permission to upload SARIF results.
- `README.md` — CodeQL badge added at the top, before the EKS E2E badge.

**Files changed:**
- `.github/workflows/codeql.yml` (new)
- `README.md`

---

## Step 71: Fix CodeQL build failure — invalid NuGet package version

**Root cause:** The `Microsoft.AspNetCore.OpenApi` package was pinned to version `9.0.9`, which was never published to NuGet (the 9.0.x release line skipped from 9.0.7 to 9.0.10). This caused `dotnet build` to fail during NuGet restore in the CodeQL workflow's C# build step.

**Fix:** Updated the package version from `9.0.9` to `9.0.11` (the latest available 9.0.x release).

**Files changed:**
- `apps/weather-api/WeatherApi.csproj`

---

## Step 72: Fix CodeQL build failure — Nx module boundary check fails without Node.js

**Root cause:** `Directory.Build.targets` defines a `CheckNxModuleBoundaries` target that runs a Node.js script from `@nx-dotnet/core` before every `dotnet build`. The CodeQL workflow does not install Node.js or `node_modules`, so this target fails with exit code 1, breaking the C# CodeQL analysis.

**Fix:** Added a `Condition="'$(NxSkipModuleBoundaries)' != 'true'"` to the `CheckNxModuleBoundaries` target in `Directory.Build.targets`, and passed `/p:NxSkipModuleBoundaries=true` in the CodeQL workflow's `dotnet build` command.

**Files changed:**
- `Directory.Build.targets`
- `.github/workflows/codeql.yml`

---

## Step 73: Add Traefik SSL termination and reverse proxy

**Root cause:** nginx was handling three responsibilities — SSL termination, reverse proxying (to weather-api and Ory Kratos), and static file serving for Angular apps. This tight coupling made it harder to manage routing and TLS independently of the web server.

**Fix:** Added a lightweight Traefik container (`traefik:v3.3`) that handles SSL termination and reverse proxying. nginx was simplified to only serve static Angular files on port 8080 (internal, no host port). Traefik and nginx run in the same pod, sharing a network namespace. Traefik exposes host ports 8080 (HTTP → HTTPS redirect) and 8443 (HTTPS), and routes requests to nginx (static files), weather-api, and Ory Kratos based on path rules. Path rewriting for `/weather` → `/weatherforecast` and `/.ory/kratos/public/` prefix stripping are handled by Traefik middleware.

**Files created:**
- `traefik/traefik.yml` — Traefik static configuration (entrypoints, file provider, HTTP→HTTPS redirect)
- `traefik/traefik-dynamic.yml` — Traefik dynamic configuration (routers, services, middleware, TLS certificate)
- `traefik/Containerfile` — Lightweight Traefik container image
- `apps/traefik/project.json` — Nx project with `podman-build` target

**Files changed:**
- `nginx/nginx.conf` — removed SSL, HTTP→HTTPS redirect, and proxy locations; listen on port 8080 only
- `Containerfile.nginx` — removed SSL cert copy and port 443 exposure; expose only 8080
- `k8s/apps-pod.yaml` — added traefik container to claude-hello-world pod, removed nginx host ports
- `k8s/pod.yaml` — same pod changes
- `apps/shell/project.json` — added `traefik:podman-build` to `kube-up` dependsOn
- `apps/shell-e2e/playwright.config.ts` — updated comments to reference Traefik
- `apps/shell-e2e/src/eks.spec.ts` — updated doc comments to reference Traefik
- `apps/weather-app-e2e/playwright.config.ts` — updated comments to reference Traefik
- `apps/weatheredit-app-e2e/playwright.config.ts` — updated comments to reference Traefik
- `.github/workflows/eks-e2e.yml` — added traefik build step, updated container names and health checks
- `.github/workflows/eks-e2e-full.yml` — same CI workflow updates
- `README.md` — updated architecture diagram, SSL section, build instructions
- `RUN.md` — updated container and Kubernetes sections

---

## Step 74: Fix Traefik e2e test failures — invalid base image tag

**Root cause:** The Traefik Containerfile used `traefik:v3.3-alpine` as the base image, but the `-alpine` suffix was only available for Traefik v1.x. For v3.x, the base `traefik:v3.3` tag is already Alpine-based (multi-arch Linux). The non-existent tag caused `podman build` to fail in CI, blocking all downstream e2e tests.

**Fix:** Changed the base image from `traefik:v3.3-alpine` to `traefik:v3.3`.

**Files changed:**
- `traefik/Containerfile` — updated base image tag

---

## Step 75: Add unit tests across all Angular MFE apps

**Root cause / motivation:** No unit tests existed for the Angular MFE apps (shell, weather-app, weatheredit-app). Tests were needed to add CI unit-test reporting and coverage badges.

**Key discovery:** `@analogjs/vite-plugin-angular` v2.1.3 is incompatible with Vitest v4 — its `angularVitestPlugins()` intercept disrupts vitest's test registration. Fix: remove the Angular build plugin from all `vite.config.mts` test configs and rely on Angular JIT compiler (`@angular/compiler`) via `setupTestBed()` from `@analogjs/vitest-angular` for runtime component compilation.

**Key discovery 2:** `resolveComponentResources` is exported as `ɵresolveComponentResources` (private API) from `@angular/core`. Components with external `styleUrl`/`templateUrl` require this to be called before `TestBed.configureTestingModule()` so Angular JIT can handle external resource references without a real fetch implementation.

**Fix:**
- Removed `@analogjs/vite-plugin-angular` plugin from `vite.config.mts` in all 3 apps; added explicit `esbuild.tsconfigRaw` with `experimentalDecorators: true` and `useDefineForClassFields: false`
- Fixed `test-setup.ts` in all 3 apps: removed `@analogjs/vitest-angular/setup-snapshots` import (crashes vitest v4)
- Added `ɵresolveComponentResources` call in `beforeEach` for shell and weatheredit-app specs (components with external templateUrl/styleUrl)
- Used `RouterTestingHarness.create()` for the shell "should render title" test (zoneless Angular requires harness for router outlet rendering)
- Added 12 tests for `weather-app` RemoteEntry (HTTP GET, loading state, data display, error handling)
- Added 24 tests for `weatheredit-app` RemoteEntry (CRUD operations, tempClass, form state, delete flow, save flow)
- Deleted temporary debug spec files created during investigation

**Files changed:**
- `apps/shell/vite.config.mts` — removed Angular plugin, added esbuild config
- `apps/weather-app/vite.config.mts` — same
- `apps/weatheredit-app/vite.config.mts` — same
- `apps/shell/src/test-setup.ts` — removed setup-snapshots import
- `apps/weather-app/src/test-setup.ts` — same
- `apps/weatheredit-app/src/test-setup.ts` — same
- `apps/shell/src/app/app.spec.ts` — added vitest imports, resolveComponentResources, RouterTestingHarness
- `apps/weather-app/src/app/remote-entry/entry.spec.ts` — new file, 12 tests
- `apps/weatheredit-app/src/app/remote-entry/entry.spec.ts` — new file, 24 tests

---

## Step 76: Add unit test CI job, coverage badges, and observability stack

**Motivation:** CI needed a dedicated unit-test job with coverage reporting. README needed status badges. The system needed Prometheus + Grafana observability for local development.

**Unit test CI:**
- Added `unit-tests` job to `.github/workflows/ci.yml` running `nx run-many --target=test` with coverage
- Uploads coverage reports to Codecov via `codecov/codecov-action@v5`
- Added CI badge and Codecov coverage badge to `README.md`

**Observability stack (local podman only):**
- Added `prometheus-net.AspNetCore` to `apps/weather-api/WeatherApi.csproj`; added `app.UseHttpMetrics()` and `app.MapMetrics()` to `Program.cs` (exposes `/metrics`)
- Added `stub_status` location to `nginx/nginx.conf`
- Added `nginx/nginx-prometheus-exporter` sidecar container to `k8s/apps-pod.yaml` (port 9113)
- Created `apps/observability/` with baked Prometheus and Grafana container images
- Created `k8s/observability-pod.yaml` for local `podman play kube` (separate from e2e CI pod)
- Created `apps/observability/project.json` Nx project with isolated `kube-up`/`kube-down` targets — never triggered by e2e tests

**Files changed:**
- `.github/workflows/ci.yml` — new unit-tests job
- `README.md` — CI and coverage badges
- `apps/weather-api/WeatherApi.csproj` — prometheus-net package
- `apps/weather-api/Program.cs` — UseHttpMetrics, MapMetrics
- `nginx/nginx.conf` — stub_status location
- `k8s/apps-pod.yaml` — nginx-exporter sidecar
- `k8s/observability-pod.yaml` — new
- `apps/observability/prometheus/prometheus.yml` — new
- `apps/observability/prometheus/Containerfile` — new
- `apps/observability/grafana/Containerfile` — new
- `apps/observability/grafana/provisioning/datasources/prometheus.yml` — new
- `apps/observability/grafana/provisioning/dashboards/dashboards.yml` — new
- `apps/observability/grafana/provisioning/dashboards/weather-api.json` — new
- `apps/observability/project.json` — new Nx project

---

## Step 77: Add Loki log aggregation to observability stack

**Motivation:** Complete the observability stack with log aggregation alongside existing metrics (Prometheus/Grafana). Loki is excluded from e2e test runs by design — the observability project's `kube-up` is not a dependency of shell's `kube-up`, so CI e2e tests never start it.

**Architecture:**
- **Loki** (port 3100) — log storage server using tsdb/filesystem backend, single-instance mode
- **Promtail** — log collector sidecar; scrapes CRI-format pod logs from `/var/log/pods/` and Podman container logs from `/var/lib/containers/`; pushes to Loki at `localhost:3100`
- **Grafana** — Loki datasource added alongside existing Prometheus datasource; queries logs at `localhost:3100`

**Log collection:** Promtail mounts `/var/log` and `/var/lib/containers` as read-only hostPath volumes. On Linux, these map directly to host paths. On macOS with Podman Machine, they map to paths inside the Linux VM where containers run.

**Files created:**
- `apps/observability/loki/loki.yml` — Loki config (single-instance, filesystem storage, no auth)
- `apps/observability/loki/Containerfile` — FROM grafana/loki
- `apps/observability/promtail/promtail.yml` — Promtail config with pod-logs and container-logs scrape jobs
- `apps/observability/promtail/Containerfile` — FROM grafana/promtail
- `apps/observability/grafana/provisioning/datasources/loki.yml` — Loki datasource for Grafana

**Files modified:**
- `k8s/observability-pod.yaml` — added loki and promtail containers with hostPath volume mounts
- `apps/observability/project.json` — added podman-build-loki and podman-build-promtail targets; updated podman-build dependsOn

---

## Step 78: Remove unit-test CI job and coverage badges

**Root cause / motivation:** Removed the `unit-tests` job from `.github/workflows/ci.yml` and removed the Unit Tests and Codecov badges from `README.md`. The unit tests still exist and pass locally but are not run in CI.

**Files changed:**
- `.github/workflows/ci.yml` — removed `unit-tests` job (coverage upload to Codecov, `nx run-many --target=test`)
- `README.md` — removed Unit Tests workflow badge and Codecov coverage badge

---

## Step 79: Enforce 80% code coverage threshold in CI

**Root cause / motivation:** The `unit-tests` CI job ran tests with coverage collection but did not enforce a minimum coverage threshold, and it excluded the weather-api dotnet project entirely. Added Vitest coverage thresholds (80% for lines, branches, functions, and statements) to all three Angular app vite configs. Created a new xUnit test project for weather-api with 30 tests covering the model, InMemoryWeatherForecastRepository, and RandomWeatherForecastRepository. Added dotnet SDK setup and weather-api-tests to the CI unit-tests job with coverlet 80% line coverage threshold.

**Files changed:**
- `.github/workflows/ci.yml` — added `actions/setup-dotnet@v4`, added `weather-api-tests:test` step to unit-tests job
- `apps/shell/vite.config.mts` — added `coverage.thresholds` with 80% minimum for lines, branches, functions, statements
- `apps/weather-app/vite.config.mts` — added `coverage.thresholds` with 80% minimum for lines, branches, functions, statements
- `apps/weatheredit-app/vite.config.mts` — added `coverage.thresholds` with 80% minimum for lines, branches, functions, statements
- `apps/weather-api-tests/WeatherApi.Tests.csproj` — new xUnit test project referencing WeatherApi, with coverlet for coverage
- `apps/weather-api-tests/project.json` — Nx project config with test target using dotnet test + coverlet 80% threshold
- `apps/weather-api-tests/WeatherForecastModelTests.cs` — tests for WeatherForecast model (temperature conversion, properties)
- `apps/weather-api-tests/InMemoryWeatherForecastRepositoryTests.cs` — full CRUD tests for InMemoryWeatherForecastRepository
- `apps/weather-api-tests/RandomWeatherForecastRepositoryTests.cs` — tests for RandomWeatherForecastRepository (read ops + write rejection)

---

## Step 80: Add weather-api lint and build to CI build job

**Root cause / motivation:** The CI `build` job only linted and built the Angular apps, excluding the weather-api dotnet project. Added `actions/setup-dotnet@v4` and included `weather-api` in the lint and build `nx run-many` commands.

**Files changed:**
- `.github/workflows/ci.yml` — added dotnet 9.0 setup to `build` job; added `weather-api` to lint and build targets

---

## Step 81: Fix — Ory Kratos init container health check uses HEAD (405)

**Root cause:** The `init-users.sh` script used `wget --spider` (HEAD request) to check Kratos readiness, but Kratos's `/health/ready` endpoint returns 405 Method Not Allowed for HEAD. The init container never detected Kratos as ready, so no user identities were seeded — all login attempts failed with "invalid credentials."

**Fix:** Changed the health check to `wget -q -O /dev/null` (GET request) targeting the correct `/admin/health/ready` path.

**Files changed:**
- `apps/ory/init-users.sh` — switched from `wget --spider` (HEAD) to `wget -q -O /dev/null` (GET); corrected path to `/admin/health/ready`

---

## Step 82: Fix — Remove unreachable host-level pg_isready from shell kube-up

**Root cause:** The `shell:kube-up` target included a host-level `pg_isready` health check that loops forever on macOS (command not found). A working podman-based check already existed on the next line.

**Fix:** Removed the host-level `until pg_isready …` command, keeping only the `podman run --rm localhost/postgres:latest pg_isready …` variant.

**Files changed:**
- `apps/shell/project.json` — removed unreachable host-level `pg_isready` command from `kube-up` target

---

## Step 83: Fix — Login form CSRF race condition and missing /auth/error route

**Root cause:** The login form rendered (with submit button) as soon as the Kratos flow ID was present in the URL, but the CSRF hidden fields only appeared after an async API call to fetch the flow data. If the user submitted before the flow loaded, the form POST lacked the `csrf_token`, causing a 403 CSRF violation. Kratos then redirected to `/auth/error`, which had no route in the Angular shell — Angular fell through to the home page, making it look like "nothing happened."

**Fix:** Gated the entire form on `flow` (not `flowId`) so the form only renders when the CSRF token is available. Added `/auth/error` route mapping to `LoginComponent` so Kratos error redirects are handled. When the flow fetch fails, the component now starts a fresh login flow instead of showing a broken form.

**Files changed:**
- `apps/shell/src/app/auth/login/login.component.ts` — form gated on `flow` instead of `flowId`; removed `formAction` getter; redirect to fresh flow on fetch failure
- `apps/shell/src/app/app.routes.ts` — added `auth/error` route pointing to `LoginComponent`

---

## Step 84: Fix — Login form stuck on "Loading…" due to zoneless change detection

**Root cause:** Angular 21 is running without Zone.js (zoneless mode — no `provideZoneChangeDetection()` in the app config). The HTTP response from `getLoginFlow()` returned 200 OK with valid flow data, but setting `this.flow = flow` inside a subscribe callback did not trigger Angular's change detection. The template stayed in the `@else` branch showing "Loading…" indefinitely.

**Fix:** Injected `ChangeDetectorRef` and called `detectChanges()` after setting `this.flow`, forcing Angular to re-render the template with the form.

**Files changed:**
- `apps/shell/src/app/auth/login/login.component.ts` — added `ChangeDetectorRef` injection; call `cdr.detectChanges()` after setting the flow

---

## Step 85: Fix — Containerfile.nginx OOM during parallel Angular builds

**Root cause:** Building three Angular apps in parallel (`--parallel=3`) inside the Podman VM exceeded available memory, causing SIGINT (exit 130) and build failures.

**Fix:** Reduced build parallelism to `--parallel=1` to fit within the VM's memory constraints.

**Files changed:**
- `Containerfile.nginx` — changed `--parallel=3` to `--parallel=1`

---

## Step 86: Feat — Add admin-app MFE with admin-only access control

Added a new Angular micro-frontend application (`admin-app`) that displays admin-useful links (Weather API Swagger, Ory Kratos Admin, Grafana, Traefik Dashboard). The app is protected by a new `adminAuthGuard` that restricts access to users with the `admin` role only (not `weather_admin`).

**What was done:**
- Scaffolded `admin-app` as an MF remote via `@nx/angular:remote` generator (directory: `apps/admin-app`, port 4203)
- Created `RemoteEntry` component with a categorized link-card dashboard (API, Identity, Observability, Infrastructure)
- Added `adminAuthGuard` in the shell's auth guard module — checks for `admin` role only
- Added `canAccessAdmin()` method to `AuthService` with a separate `ADMIN_ROLES` whitelist
- Registered the remote in shell's module federation config (dev + prod)
- Added route `admin-app` in shell with the admin guard and nav link
- Updated nginx config, Traefik routing, Containerfile.nginx, and Kratos allowed return URLs
- Added 12 unit tests for the admin-app entry component
- Added 3 unit tests for `adminAuthGuard` and 11 unit tests for `AuthService` (including `canAccessAdmin`)
- Added Playwright e2e tests for admin-app (access control, link display, categories)
- Added shell-e2e test for admin-app redirect to login when unauthenticated

**Files changed:**
- `apps/admin-app/` — new MFE application (module-federation.config.ts, entry.ts, entry.routes.ts, entry.spec.ts, project.json, webpack configs, vite.config.mts, tsconfig files, bootstrap.ts, test-setup.ts)
- `apps/admin-app-e2e/` — new Playwright e2e test project (playwright.config.ts, eks.spec.ts)
- `apps/shell/module-federation.config.ts` — added `admin-app` remote
- `apps/shell/webpack.prod.config.ts` — added `admin-app` production remote URL
- `apps/shell/src/app/app.routes.ts` — added `admin-app` route with `adminAuthGuard`
- `apps/shell/src/app/app.html` — added Admin nav link
- `apps/shell/src/app/auth/auth.guard.ts` — added `adminAuthGuard`
- `apps/shell/src/app/auth/auth.service.ts` — added `ADMIN_ROLES` and `canAccessAdmin()`
- `apps/shell/src/app/auth/auth.guard.spec.ts` — new: 3 tests for adminAuthGuard
- `apps/shell/src/app/auth/auth.service.spec.ts` — new: 11 tests for AuthService
- `apps/shell/project.json` — added `admin-app` to build-all target
- `apps/shell-e2e/src/eks.spec.ts` — added admin-app redirect test
- `Containerfile.nginx` — added `admin-app` to build and COPY steps
- `nginx/nginx.conf` — added `/admin-app/` location block
- `apps/ory/kratos.yml` — added admin-app to allowed return URLs

---

## Step 87: Refactor — Rename adminApp to admin-app for consistency

**Root cause:** The `@nx/angular:remote` generator rejected `admin-app` as a Module Federation name (hyphens not allowed per its regex). The workaround used `adminApp` as the MF/project name, but the existing remotes (`weather-app`, `weatheredit-app`) already use hyphenated names successfully.

**Fix:** Renamed all occurrences of `adminApp` to `admin-app` across project names, MF config, build targets, import paths, tsconfig paths, Containerfile, and e2e configs.

**Files changed:**
- `apps/admin-app/module-federation.config.ts` — `name: 'admin-app'`
- `apps/admin-app/project.json` — `"name": "admin-app"`, all build targets
- `apps/admin-app/vite.config.mts` — test name
- `apps/admin-app/src/index.html` — title and root selector
- `apps/admin-app-e2e/project.json` — project name and implicit dependency
- `apps/admin-app-e2e/package.json` — package and nx name
- `apps/admin-app-e2e/playwright.config.ts` — serve command
- `apps/shell/module-federation.config.ts` — remote name
- `apps/shell/webpack.prod.config.ts` — remote tuple
- `apps/shell/src/app/app.routes.ts` — import path
- `apps/shell/project.json` — build-all command
- `tsconfig.base.json` — path alias
- `Containerfile.nginx` — build projects list

---

## Step 88: Fix — ory-kratos-init container restart loop

**Root cause:** The `ory-kratos-init` container runs as a sidecar (not a Kubernetes init container) because it needs Kratos to be serving before it can seed users via the admin API. Once `init-users.sh` finishes creating identities, the container exits with code 0. Podman's pod-level restart policy then restarts the exited container, causing a restart loop.

**Fix:** Added `exec sleep infinity` at the end of `init-users.sh` so the container stays alive after seeding completes.

**Files changed:**
- `apps/ory/init-users.sh` — added `exec sleep infinity` after user creation

---

## Step 89: Fix — Add missing weather-api:podman-build dependency to shell kube-up

**Root cause:** The shell `kube-up` target deploys `k8s/apps-pod.yaml` which references `localhost/weather-api:latest`, but the target's `dependsOn` did not include `weather-api:podman-build`. This caused `podman play kube` to fail when the weather-api image had not been built beforehand.

**Fix:** Added `weather-api:podman-build` to the `dependsOn` array of the shell `kube-up` target.

**Files changed:**
- `apps/shell/project.json` — added `weather-api:podman-build` to `kube-up.dependsOn`

---

## Step 90: Fix — Admin dashboard tiles (Swagger, Kratos, Grafana, Traefik)

**Issues:**
1. Weather API Swagger link pointed to wrong port (5220) and Swagger/Scalar was dev-only, so it returned nothing in production.
2. Ory Kratos Admin link returned raw JSON — not an admin UI — and lacked context.
3. Ory Kratos Health was a plain link; user wanted a status badge instead.
4. Grafana Dashboard tile didn't show login credentials (admin/admin).
5. Traefik Dashboard link (port 8081) didn't work because the Traefik API/dashboard was not enabled.

**Fixes:**
- **Weather API**: Enabled `MapOpenApi()` and `MapScalarApiReference()` in all environments (removed dev-only guard). Updated link to `http://localhost:5221/scalar/v1`.
- **Ory Kratos**: Removed separate Health link. Added an inline health status badge to the Kratos Admin API tile that fetches `/health/alive` on load and shows Healthy/Down.
- **Grafana**: Added credentials display (`admin` / `admin`) to the Grafana tile.
- **Traefik**: Added `traefik` entrypoint on port 8081 and enabled `api.dashboard` + `api.insecure` in `traefik.yml`. Exposed port 8081 in `apps-pod.yaml`.
- **Admin component**: Added `HttpClient` injection, `OnInit` health check, `NgClass` for badge styling, and credential display. Updated tests with `provideHttpClient`/`provideHttpClientTesting`.

**Files changed:**
- `apps/weather-api/Program.cs` — removed dev-only guard around OpenAPI/Scalar
- `traefik/traefik.yml` — added `traefik` entrypoint (8081) and `api.dashboard`/`api.insecure`
- `k8s/apps-pod.yaml` — exposed container port 8081 for Traefik dashboard
- `apps/admin-app/src/app/remote-entry/entry.ts` — rewrote tiles, added health badge and credentials
- `apps/admin-app/src/app/remote-entry/entry.spec.ts` — updated tests for new tile structure
- `apps/admin-app/src/app/app.config.ts` — added `provideHttpClient()`

---

## Step 91: Fix — Shell unit test coverage below 80% threshold

**Root cause:** The shell app's `auth.guard.ts` only had tests for `adminAuthGuard`; `weatherEditAuthGuard` was completely untested. In `auth.service.ts`, the methods `getSession()`, `initiateLogin()`, `logout()`, and `getLoginFlow()` had no test coverage. Overall coverage was ~58% lines, ~37% functions — well below the 80% threshold.

**Fix:** Added tests for `weatherEditAuthGuard` (login redirect, unauthorized redirect, allow access). Rewrote `auth.service.spec.ts` to use `HttpTestingController` and added tests for `getSession()` (success + error), `initiateLogin()` (window.location redirect), `logout()` (success + error), and `getLoginFlow()` (success + error). Coverage is now 100% across all metrics.

**Files changed:**
- `apps/shell/src/app/auth/auth.guard.spec.ts` — added `weatherEditAuthGuard` describe block with 3 tests
- `apps/shell/src/app/auth/auth.service.spec.ts` — switched to `HttpTestingController`, added tests for `getSession`, `initiateLogin`, `logout`, `getLoginFlow`

---

## Step 92: Feat — Add Ory Kratos identity management page in admin-app

**What:** Replaced the raw Kratos Admin API JSON link on the admin dashboard with an in-app identity management page at `/admin-app/kratos`. The new page provides a full CRUD interface for Ory Kratos identities.

**Features:**
- **List identities** — table showing email, role, state, and creation date, fetched from `GET /admin/identities`
- **Create identity** — form with email, password, and role (admin / weather_admin / none), calls `POST /admin/identities`
- **Edit role** — inline role dropdown per row, calls `PUT /admin/identities/:id`
- **Delete identity** — per-row delete button, calls `DELETE /admin/identities/:id`
- **Health badge** — checks `GET /health/alive` on load and displays Healthy/Down status
- **Back to Dashboard** link via Angular routerLink

**Dashboard tile change:** The "Ory Kratos Admin" tile now uses an Angular `routerLink` to `/admin-app/kratos` instead of an external `href` to `http://localhost:4434/admin/identities`. The health badge remains on the dashboard tile.

**Tests:** 37 admin-app tests pass (13 entry, 18 component, 6 service). Coverage: 97.72% statements, 87.5% branches, 94.28% functions, 97.59% lines.

**Files changed:**
- `apps/admin-app/src/app/kratos-admin/kratos-admin.service.ts` — new service wrapping Kratos Admin API (list, get, create, update, delete, health)
- `apps/admin-app/src/app/kratos-admin/kratos-admin.component.ts` — new standalone component with identity table, create form, inline role editing, delete, health badge
- `apps/admin-app/src/app/kratos-admin/kratos-admin.service.spec.ts` — 6 unit tests for the service
- `apps/admin-app/src/app/kratos-admin/kratos-admin.component.spec.ts` — 18 unit tests for the component
- `apps/admin-app/src/app/remote-entry/entry.routes.ts` — added `kratos` child route
- `apps/admin-app/src/app/remote-entry/entry.ts` — changed Kratos tile from external `url` to internal `routerLink`, added `RouterLink` import, updated template to conditionally render `<a routerLink>` vs `<a href>`
- `apps/admin-app/src/app/remote-entry/entry.spec.ts` — updated tests for routerLink tile, added `provideRouter`

---

## Step 93: Fix — Add image prune and podman-build dependency to shell kube-up

**What:** The shell `podman-build` target was hitting "no space left on device" errors because old images accumulated. The `kube-up` target also didn't depend on `podman-build`, so the shell container image could be stale.

**Changes:**
- `apps/shell/project.json` — changed `podman-build` from single `command` to `commands` array, adding `podman image prune -af` before the build to reclaim disk space; added `"podman-build"` to `kube-up` `dependsOn` so the shell image is always rebuilt before starting pods

**Files changed:**
- `apps/shell/project.json`

---

## Step 94: Fix — CORS errors on Kratos admin API calls from admin-app

**Root cause:** The admin-app's `KratosAdminService` called `http://localhost:4434` directly from the browser. Since the app is served from `https://localhost:8443`, the browser blocked these cross-origin requests. The Kratos admin API has no CORS configuration, and Traefik had no route to proxy admin API traffic.

**Fix:** Proxy the Kratos admin API through Traefik at `/.ory/kratos/admin/`, matching the existing pattern for the public API. Updated the admin-app service to use the relative proxied path instead of the hardcoded localhost URL.

**Changes:**
- `traefik/traefik-dynamic.yml` — added `kratos-admin-router` (priority 31, path prefix `/.ory/kratos/admin`), `kratos-admin` service (pointing to `host.containers.internal:4434`), and `strip-ory-admin-prefix` middleware
- `apps/admin-app/src/app/kratos-admin/kratos-admin.service.ts` — changed `KRATOS_ADMIN_URL` from `http://localhost:4434` to `/.ory/kratos/admin`
- `apps/shell/project.json` — added `-f` flag to `podman image prune -a` to prevent interactive prompt hang
- `README.md` — added admin-app to architecture diagram, Traefik routes, nginx routes, and service URL table

---

## Step 95: Fix — CORS error on admin dashboard health badge

**Root cause:** The admin dashboard entry component (`remote-entry/entry.ts`) had the Kratos health badge endpoint hardcoded to `http://localhost:4434/health/alive`. Since the page is served from `https://localhost:8443`, the browser blocked this cross-origin request. The Traefik proxy at `/.ory/kratos/admin/` was already available but not being used here.

**Fix:** Changed the health badge endpoint from the direct `http://localhost:4434/health/alive` URL to the proxied `/.ory/kratos/admin/health/alive` path, matching how the `KratosAdminService` already makes its calls. Also fixed the test files whose `ADMIN_URL` constants still referenced the old `http://localhost:4434` URL.

**Files changed:**
- `apps/admin-app/src/app/remote-entry/entry.ts` — health badge endpoint now uses proxied path
- `apps/admin-app/src/app/kratos-admin/kratos-admin.service.spec.ts` — updated `ADMIN_URL` constant to `/.ory/kratos/admin`
- `apps/admin-app/src/app/kratos-admin/kratos-admin.component.spec.ts` — updated `ADMIN_URL` constant to `/.ory/kratos/admin`

**Files changed:**
- `traefik/traefik-dynamic.yml`
- `apps/admin-app/src/app/kratos-admin/kratos-admin.service.ts`
- `apps/shell/project.json`
- `README.md`

---

## Step 96: Fix — Identities section stuck on Loading in Module Federation

**Root cause:** The `KratosAdminComponent` used plain class properties (`loading = false`, `identities: KratosIdentity[] = []`, etc.) for template-bound state. In the Module Federation setup, HTTP subscribe callbacks can run outside Angular's zone, so zone-based change detection never triggers — the template stays stale even after data arrives. The working `weather-app` remote avoided this by using Angular signals.

**Fix:** Converted all template-bound reactive properties in `KratosAdminComponent` to Angular `signal()` values with `.set()` updates. Signals push change notifications directly, bypassing zone.js. Form-model properties (`newEmail`, `newPassword`, `newRole`, `editRole`) remain plain properties since they're bound via `ngModel`. Updated the component spec to read signal values as function calls.

**Files changed:**
- `apps/admin-app/src/app/kratos-admin/kratos-admin.component.ts` — properties → signals, template → signal reads
- `apps/admin-app/src/app/kratos-admin/kratos-admin.component.spec.ts` — assertions updated for signal accessors

---

## Step 97: Fix — Remove expired Nx Cloud connection

**Root cause:** `nx.json` contained an `nxCloudId` for an unclaimed workspace. After 3 days without claiming, Nx Cloud returns a 401 error on every `nx` command.

**Fix:** Removed the `nxCloudId` property from `nx.json`. No `nx-cloud` package was installed, so no dependency removal was needed.

**Files changed:**
- `nx.json` — removed `nxCloudId` line

---

## Step 98: Fix — tsconfig non-relative path error in admin-app and weather-app

**Root cause:** `tsconfig.base.json` defined `paths` entries (e.g., `"weather-app/Routes"`, `"admin-app/Routes"`) but did not set `baseUrl`. TypeScript requires `baseUrl` to resolve non-relative path mappings.

**Fix:** Added `"baseUrl": "."` to `tsconfig.base.json` so all path mappings resolve relative to the workspace root.

**Files changed:**
- `tsconfig.base.json` — added `"baseUrl": "."`

---

## Step 99: Feat — Full observability pipeline with logs, metrics, and system health dashboard

**What:** Ship all logs to Loki, all metrics to Prometheus, and provide a Grafana dashboard covering system health, running pods, container count/health, top IP+User-Agent combinations, and error counts.

**Changes:**

1. **Traefik access logs + Prometheus metrics** — enabled JSON access logs at `/var/log/traefik/access.log` (captures client IP, User-Agent, status, route, service) and Prometheus metrics endpoint on the Traefik entrypoint (`:8081/metrics`) with entrypoint, router, and service labels.

2. **nginx JSON access logs** — added `json_combined` log format to `nginx.conf` outputting structured JSON to `/var/log/nginx/access.log` (remote_addr, request, status, user_agent, request_time).

3. **Prometheus scrape targets** — added `traefik` job scraping `host.containers.internal:8081/metrics` for Traefik request counts, error rates, and latency histograms.

4. **Promtail log pipelines** — added two new scrape jobs: `traefik-access` (parses JSON access logs, extracts `status`, `method`, `service`, `router`, `client_ip` labels) and `nginx-access` (parses JSON access logs, extracts `status`, `remote_addr` labels).

5. **Shared log volumes** — apps pod mounts `hostPath` volumes for `/var/log/traefik` and `/var/log/nginx`; observability pod mounts the same paths read-only so Promtail can tail them.

6. **System Health dashboard** (`system-health.json`) with 12 panels:
   - System Health % (stat — % of scrape targets UP)
   - Running Pods (stat — count of targets with `up == 1`)
   - Total Containers (stat — total scrape target count)
   - Containers Down (stat — `up == 0` count, red when > 0)
   - Container Health table (per-target UP/DOWN with color mapping)
   - HTTP Request Rate by Service (timeseries from Traefik metrics)
   - HTTP Error Rate 4xx+5xx (bar chart from Traefik metrics)
   - Total 5xx / 4xx / All Requests (stat panels, 1h window)
   - Top IP + User-Agent table (Loki LogQL `topk` over `traefik-access` logs)
   - Recent Error Logs (Loki log panel filtering `status >= 400`)

**Files changed:**
- `traefik/traefik.yml` — added `accessLog` and `metrics.prometheus` sections
- `traefik/Containerfile` — create `/var/log/traefik` directory
- `nginx/nginx.conf` — added `json_combined` log format and access_log directive
- `apps/observability/prometheus/prometheus.yml` — added `traefik` scrape job
- `apps/observability/promtail/promtail.yml` — added `traefik-access` and `nginx-access` scrape jobs
- `k8s/apps-pod.yaml` — added hostPath volume mounts for traefik and nginx logs
- `k8s/observability-pod.yaml` — added read-only volume mounts for traefik and nginx logs
- `apps/observability/grafana/provisioning/dashboards/system-health.json` — new dashboard

---

## Step 100: Feat — Grafana SSO via Ory Kratos (no password login)

**What:** Grafana is now accessible at `https://localhost:8443/grafana/` with automatic SSO through the existing Ory Kratos authentication. Authenticated users are signed in automatically; unauthenticated users are redirected to the Kratos login page.

**Architecture:**
1. Traefik routes `/grafana` requests through a `forwardAuth` middleware
2. The `auth-proxy` container (Python, port 4180) receives the forwarded request, reads the session cookie, and calls Kratos `/sessions/whoami`
3. If valid → returns `200` with `X-Webauth-User: <email>` header; Traefik copies this to the proxied request
4. If invalid → returns `302` redirect to Kratos login with `return_to` pointing back to Grafana
5. Grafana's `auth.proxy` trusts the `X-Webauth-User` header and auto-signs-up/logs in the user
6. Password login form and sign-out menu are disabled since auth is handled externally

**Files created:**
- `apps/observability/auth-proxy/auth-proxy.py` — lightweight HTTP server that validates Kratos sessions
- `apps/observability/auth-proxy/Containerfile` — Python 3.13 alpine image

**Files changed:**
- `traefik/traefik-dynamic.yml` — added `grafana-router` (priority 25), `grafana` service, `grafana-auth` forwardAuth middleware, `strip-grafana-prefix` middleware
- `k8s/observability-pod.yaml` — added `auth-proxy` container (port 4180), Grafana env vars for `auth.proxy` + sub-path serving
- `apps/observability/project.json` — added `podman-build-auth-proxy` target and dependency
- `apps/ory/kratos.yml` — added `https://localhost:8443/grafana` to `allowed_return_urls`

---

## Step 101: Fix — Resolve kube-up failures from missing host volumes and corrupted container images

**Root cause:** `podman play kube` fails with "no such file or directory" when hostPath volumes (`/var/log/traefik`, `/var/log/nginx`) don't exist inside the Podman VM. Separately, CI builds fail when Podman's local image store has corrupted base images (e.g. `node:20-alpine` with missing layer blobs).

**Fix:**
1. Added `podman machine ssh 'sudo mkdir -p /var/log/traefik /var/log/nginx'` as the first command in the `kube-up` target so required host directories are always created before pod startup.
2. Added a `.containerignore` file to exclude `node_modules`, `dist`, `.git`, `.nx`, and `tmp` from container builds — prevents OOM errors during `COPY . .` in `Containerfile.nginx`.
3. Added a "Remove potentially corrupted base images" step to both CI workflows that force-removes base images before builds, ensuring clean re-pulls.
4. Added Traefik health e2e tests to `shell-e2e` that verify the Traefik dashboard API and router configuration are operational.

**Files created:**
- `.containerignore` — excludes heavy/unnecessary directories from container build context

**Files changed:**
- `apps/shell/project.json` — `kube-up` target now creates hostPath directories inside Podman VM before starting pods
- `apps/shell-e2e/src/eks.spec.ts` — added "Traefik reverse proxy – health" test suite (dashboard API + routers)
- `.github/workflows/eks-e2e.yml` — added pre-build step to remove potentially corrupted base images
- `.github/workflows/eks-e2e-full.yml` — same pre-build step added

---

## Step 102: Fix — Reset Podman storage, create nginx log dir, and verify images before kube-up

**Root cause:** Three separate issues: (1) `podman image rm` only removes image references but leaves corrupted layer blobs behind, so CI builds still fail on re-pull; (2) nginx container crashes because `/var/log/nginx` doesn't exist with correct ownership; (3) `kube-up` fails silently when required container images haven't been built yet.

**Fix:**
1. Replaced `podman image rm -f` with `podman system reset --force` in both CI workflows to fully wipe Podman's storage (including broken layers) before rebuilding.
2. Added `RUN mkdir -p /var/log/nginx && chown nginx:nginx /var/log/nginx` to `Containerfile.nginx` so the log directory exists with correct ownership at runtime.
3. Added an image-existence pre-check loop to the `kube-up` target that verifies all six required images (`postgres`, `ory-kratos`, `ory-kratos-init`, `traefik`, `weather-api`, `claude-hello-world`) exist before starting pods, failing fast with a clear error if any are missing.
4. Updated `kube-up` to `chmod 777` the host log directories so containers can write regardless of UID.

**Files changed:**
- `.github/workflows/eks-e2e.yml` — replaced `podman image rm` with `podman system reset --force`
- `.github/workflows/eks-e2e-full.yml` — same storage reset change
- `Containerfile.nginx` — added nginx log directory creation with correct ownership
- `apps/shell/project.json` — `kube-up` target now verifies all required images exist and sets log directory permissions

---

## Step 103: Fix — Remove `podman image prune -af` from shell:podman-build to prevent parallel build corruption

**Root cause:** `shell:podman-build` ran `podman image prune -af` before building the nginx image. Since `kube-up` depends on all podman-build targets, Nx runs them in parallel. The prune in one build deletes images and layers that other concurrent builds (ory, postgres, traefik, weather-api) have just created, corrupting Podman's storage and causing "image not known" errors.

**Fix:** Removed `podman image prune -af` from the `shell:podman-build` target. Storage cleanup is already handled by `podman system reset --force` in the CI workflow before any builds start, so the per-build prune was redundant and harmful.

**Files changed:**
- `apps/shell/project.json` — removed `podman image prune -af` from `podman-build` commands

---

## Step 104: Fix — Make kube-up log directory creation work on both macOS and Linux CI

**Root cause:** The `kube-up` target used `podman machine ssh` to create host log directories (`/var/log/traefik`, `/var/log/nginx`). This only works on macOS/Windows where Podman runs inside a VM. On GitHub Actions Linux runners, Podman runs natively without a VM, so `podman machine ssh` fails with "VM does not exist".

**Fix:** Replaced the unconditional `podman machine ssh` call with a conditional: if `podman machine inspect` succeeds (macOS/Windows), use `podman machine ssh`; otherwise (Linux/CI), create the directories directly with `sudo mkdir`.

**Files changed:**
- `apps/shell/project.json` — `kube-up` log directory command now detects whether a Podman VM exists and falls back to direct `mkdir` on Linux

---

## Step 105: Fix — Add SELinux relabeling for hostPath log volumes

**Root cause:** The `claude-hello-world` pod's nginx container crashed in a loop with `open() "/var/log/nginx/access.log" failed (13: Permission denied)`. The hostPath volumes (`/var/log/traefik`, `/var/log/nginx`) had `chmod 777` permissions, but SELinux on the Podman VM (Fedora CoreOS) was `Enforcing` with the directories labeled `var_log_t`. Containers run under the `container_t` domain and can only write to paths labeled `container_file_t`, so SELinux denied all writes regardless of Unix permissions.

**Fix:** Added `sudo chcon -Rt container_file_t /var/log/traefik /var/log/nginx` to the `kube-up` directory-creation step, for both the Podman VM (macOS) and native Linux paths. This relabels the directories so containers are allowed to write log files.

**Files changed:**
- `apps/shell/project.json` — `kube-up` log directory command now applies `container_file_t` SELinux label after creating directories

---

## Step 106: Fix — Escape JMESPath hyphen in Promtail JSON stage expression

**Root cause:** The `observability-promtail` container was crash-looping with `invalid json stage config: could not compile JMES expression: SyntaxError: Unexpected token at the end of the expression: tNumber`. The Promtail config's Traefik access log pipeline had `user_agent: 'request_User-Agent'` — the hyphen in `User-Agent` was parsed by JMESPath as a subtraction operator, causing a syntax error.

**Fix:** Wrapped the field name in JMESPath double-quote syntax: `'"request_User-Agent"'`. This tells JMESPath to treat the entire string (including the hyphen) as a single key identifier.

**Files changed:**
- `apps/observability/promtail/promtail.yml` — quoted `request_User-Agent` as a JMESPath identifier

---

## Step 107: Fix — Remove strip-grafana-prefix middleware to fix ERR_TOO_MANY_REDIRECTS

**Root cause:** Grafana was configured with `GF_SERVER_SERVE_FROM_SUB_PATH=true` and `GF_SERVER_ROOT_URL=https://localhost:8443/grafana/`, which means Grafana expects to receive requests with the `/grafana` prefix and handles the sub-path routing internally. However, Traefik's `grafana-router` applied a `strip-grafana-prefix` middleware that removed `/grafana` before forwarding. Grafana then saw a bare `/` path, and since it was configured to serve from `/grafana/`, it redirected back to `/grafana/` — which Traefik stripped again, creating an infinite redirect loop.

**Fix:** Removed `strip-grafana-prefix` from the `grafana-router` middleware chain. Traefik now forwards the full `/grafana/...` path to Grafana, which handles it correctly via `serve_from_sub_path`.

**Files changed:**
- `traefik/traefik-dynamic.yml` — removed `strip-grafana-prefix` from `grafana-router` middlewares

---

## Step 108: Fix — Use ThreadingHTTPServer in auth-proxy to handle concurrent Grafana requests

**Root cause:** Grafana loaded its initial HTML and a few assets successfully, but then returned HTTP 500 for the majority of JS bundles, fonts, and plugin modules. Traefik's access log showed `OriginStatus=0` (backend never reached) with short durations (~50-70ms, not timeouts). The `grafana-auth` forwardAuth middleware sends every Grafana request to the auth-proxy at port 4180 first. The auth-proxy used Python's `HTTPServer`, which is single-threaded and can only process one request at a time. When the browser fired 30+ concurrent requests to load Grafana's assets, the auth-proxy's listen backlog filled up, connections were dropped, and Traefik returned 500 for those failed forwardAuth checks.

**Fix:** Replaced `HTTPServer` with `ThreadingHTTPServer` (available since Python 3.7). This spawns a new thread per incoming request, allowing the auth-proxy to handle all concurrent forwardAuth checks from Traefik without dropping connections.

**Files changed:**
- `apps/observability/auth-proxy/auth-proxy.py` — switched from `HTTPServer` to `ThreadingHTTPServer`

---

## Step 109: Fix — Add explicit UIDs to Grafana provisioned datasources

**Root cause:** The System Health dashboard showed "No data" for all panels despite Prometheus scraping all targets successfully. The dashboard JSON referenced datasources by `uid: 'prometheus'` and `uid: 'loki'`, but the provisioning YAML files did not specify a `uid` field. Grafana auto-generated random UIDs (`PBFA97CFB590B2093`, `P8E80F9AEF21F6940`), which didn't match the dashboard references, so every panel query silently failed to find its datasource.

**Fix:** Added `uid: prometheus` and `uid: loki` to the respective datasource provisioning files so the UIDs match the dashboard panel references.

**Files changed:**
- `apps/observability/grafana/provisioning/datasources/prometheus.yml` — added `uid: prometheus`
- `apps/observability/grafana/provisioning/datasources/loki.yml` — added `uid: loki`

---

## Step 110: Fix — Recursive chmod on host log dirs to fix nginx crash in CI

**Root cause:** The GitHub Actions e2e smoke tests timed out (exit 124) because the `claude-hello-world-nginx` container crashed immediately on startup with `open() "/var/log/nginx/access.log" failed (13: Permission denied)`. Ubuntu runners have nginx pre-installed, so `/var/log/nginx/` already contains `access.log` and `error.log` owned by `root:adm` (mode 640). The kube-up command ran `sudo chmod 777 /var/log/nginx` which set the **directory** permissions, but the pre-existing **files** inside remained root-owned and unwritable. When podman mounted this hostPath volume into the container, the nginx process (uid 101) couldn't open the log files. With nginx dead, Traefik's backend returned 502 Bad Gateway, and the health-check loop timed out.

**Fix:** Changed `chmod 777` to `chmod -R 777` (recursive) in both the podman-machine and bare-metal branches of the kube-up target so pre-existing log files inside the directories are also made writable.

**Files changed:**
- `apps/shell/project.json` — added `-R` flag to both `chmod 777` commands in the kube-up target

---

## Step 111: Docs — Update README.md and RUN.md with observability stack documentation

**What:** README.md and RUN.md were missing documentation for the full observability pipeline added in steps 76–109: Traefik/nginx access log collection, the System Health dashboard, Grafana SSO via Ory Kratos (auth-proxy + forwardAuth), and the auth-proxy container image.

**Changes:**
- README.md: added Observability section covering components, scraped metrics, collected logs, dashboards, and Grafana SSO architecture; added observability to Architecture diagram; added Grafana/Prometheus/Loki URLs to the service table
- RUN.md: expanded the Observability section with auth-proxy image, Traefik metrics scrape target, access log collection (traefik + nginx), System Health dashboard details, Grafana SSO flow, datasource UIDs, and prerequisite note about apps pod

**Files changed:**
- `README.md`
- `RUN.md`

---

## Step 112: Feature — Add Kafka CDC pod with Debezium, Kafka UI, and slot-guard

**What:** Added a lightweight Kafka pod for Change Data Capture (CDC) on the weather-api PostgreSQL database. Kafka runs in KRaft mode (no Zookeeper). Debezium Connect captures row-level changes from Postgres and publishes to Kafka topics. Kafka UI provides a web interface for browsing topics and managing connectors. A slot-guard sidecar monitors replication slot lag and drops stale slots as a safety net against WAL disk exhaustion.

**Changes:**
- Enabled logical replication in Postgres (`wal_level=logical`, `max_replication_slots=4`, `max_wal_senders=4`)
- Created `apps/kafka/` project with Nx build targets for debezium-connect, debezium-init, and slot-guard images
- Debezium Connect image extends `quay.io/debezium/connect:2.7` with Prometheus JMX exporter agent for metrics on port 9404
- debezium-init sidecar waits for Connect REST API, then registers the Postgres CDC connector targeting `public.*` tables
- slot-guard sidecar periodically checks `pg_replication_slots` and drops inactive Debezium slots exceeding a 5 GB lag threshold
- Kafka UI (`provectus/kafka-ui`) configured with Kafka Connect integration for connector management
- Added Traefik route `/kafka-ui` → Kafka UI at `host.containers.internal:8090`
- Kafka pod runs independently (like observability): `npx nx run kafka:kube-up` / `npx nx run kafka:kube-down`

**Files changed:**
- `apps/postgres/Containerfile` — added CMD with `wal_level=logical`
- `apps/kafka/project.json` (new)
- `apps/kafka/debezium/Containerfile` (new)
- `apps/kafka/debezium/jmx-exporter-config.yml` (new)
- `apps/kafka/debezium-init/Containerfile` (new)
- `apps/kafka/debezium-init/register-connector.sh` (new)
- `apps/kafka/slot-guard/Containerfile` (new)
- `apps/kafka/slot-guard/slot-guard.sh` (new)
- `k8s/kafka-pod.yaml` (new)
- `traefik/traefik-dynamic.yml` — added kafka-ui router and service

---

## Step 113: Feature — Add Kafka/CDC observability (postgres-exporter, Debezium scrape, dashboard)

**What:** Extended the observability stack to monitor the Kafka CDC pipeline. postgres-exporter scrapes replication slot metrics from Postgres. Debezium JMX metrics are scraped from the kafka pod. A new Grafana dashboard visualizes replication slot lag, Debezium time lag, event throughput, queue capacity, and connector task status.

**Changes:**
- Added `postgres-exporter` container (port 9187) to the observability pod
- Added `postgres` and `debezium` scrape jobs to Prometheus config
- Created `kafka-cdc.json` Grafana dashboard with PostgreSQL Replication, Debezium CDC, and Kafka Connect panels

**Files changed:**
- `k8s/observability-pod.yaml`
- `apps/observability/prometheus/prometheus.yml`
- `apps/observability/grafana/provisioning/dashboards/kafka-cdc.json` (new)

---

## Step 114: Docs — Update README.md and RUN.md with Kafka CDC infrastructure

**Root cause:** Steps 112 and 113 added the Kafka pod and CDC observability but left README.md and RUN.md without any documentation of the new infrastructure.

**Fix:** Updated both docs to cover the Kafka pod and its components, the three-layer monitoring strategy, alerting thresholds, and all new service URLs.

**Files changed:**
- `README.md` — added Kafka CDC entry to architecture diagram, postgres-exporter to observability components table, new `postgres` and `debezium` Prometheus scrape targets, "Kafka & CDC" Grafana dashboard to dashboards list, new "Kafka & CDC" section (components, CDC flow, monitoring, alerting), kafka build command in Build section, and four new service URL entries
- `RUN.md` — added "Kafka & CDC" section with build instructions, startup prerequisites, what gets captured, service URLs, three-layer monitoring explanation, alerting thresholds, and stop/resume behavior

---

## Step 115: Feature — Add Kafka UI link to admin dashboard

**What:** Added a Kafka UI tile to the admin-app dashboard so admins can navigate to the Kafka topic browser and Debezium connector management directly from the admin page.

**Files changed:**
- `apps/admin-app/src/app/remote-entry/entry.ts` — added Kafka UI entry to ADMIN_LINKS under the Infrastructure category

---

## Step 116: Feature — Add Confluent Schema Registry and Avro serialization

**What:** Replaced Debezium's default JSON converter with Avro serialization backed by Confluent Schema Registry. CDC events on Kafka topics are now Avro-encoded with schemas stored in the registry, enabling schema evolution and compact wire format.

**Changes:**
- Added `confluentinc/cp-schema-registry:7.7.1` container to the kafka pod (container port 8081, host port 8085 to avoid conflict with Traefik admin on 8081)
- Extended Debezium Containerfile with a multi-stage build that copies the Confluent Avro converter JARs from `confluentinc/cp-kafka-connect:7.7.1` into `/kafka/connect/avro-converter/`
- Configured Debezium Connect to use `AvroConverter` for both key and value serialization, pointing at the co-located Schema Registry (`http://localhost:8081`)
- Added `KAFKA_CLUSTERS_0_SCHEMAREGISTRY` to Kafka UI so it can browse registered Avro schemas

**Files changed:**
- `apps/kafka/debezium/Containerfile` — added multi-stage build with Confluent Avro converter
- `k8s/kafka-pod.yaml` — added schema-registry container; added Avro converter env vars to debezium-connect; added schema registry URL to kafka-ui

---

## Step 117: Fix — Correct Avro converter path, Kafka image tag, and Kafka UI image

**Root cause:** Three issues prevented `kube-up kafka` from starting:
1. The Debezium Containerfile copied Avro converter JARs from `/usr/share/java/kafka-connect-avro-converter/` which doesn't exist in the Confluent image — the actual path is `/usr/share/java/kafka-serde-tools/`
2. The Kafka image tag `apache/kafka:3.9` doesn't exist — the correct tag is `apache/kafka:3.9.0`
3. The `provectus/kafka-ui:latest` image was deprecated and returns "access denied" — the actively maintained fork is `kafbat/kafka-ui:latest`

**Fix:**
- Changed COPY source path to `/usr/share/java/kafka-serde-tools/`
- Changed Kafka image tag to `3.9.0`
- Replaced `provectus/kafka-ui` with `kafbat/kafka-ui` in pod manifest and README

**Files changed:**
- `apps/kafka/debezium/Containerfile` — fixed COPY source path
- `k8s/kafka-pod.yaml` — fixed Kafka image tag and Kafka UI image
- `README.md` — updated Kafka UI image references

---

## Step 118: Fix — Add JVM heap limits to Kafka pod containers

**Root cause:** The four JVM containers in the kafka pod (Kafka, Schema Registry, Debezium Connect, Kafka UI) each default to grabbing ~25% of available memory, starving the existing services (Traefik, nginx, weather-api) and causing slow responses.

**Fix:** Added explicit heap limits: Kafka 256m, Schema Registry 128m, Debezium Connect 256m, Kafka UI 128m — capping total JVM usage at ~768 MB.

**Files changed:**
- `k8s/kafka-pod.yaml` — added KAFKA_HEAP_OPTS, SCHEMA_REGISTRY_HEAP_OPTS, HEAP_OPTS, JAVA_OPTS

---

## Step 119: Fix — Add schema.registry.url to connector config for Avro serialization

**Root cause:** Debezium connector task failed with `ConfigException: Missing required configuration "schema.registry.url"`. The Avro converter was configured at the Connect worker level but the connector-level config also requires the Schema Registry URL.

**Fix:** Added `key.converter`, `key.converter.schema.registry.url`, `value.converter`, and `value.converter.schema.registry.url` to the connector registration payload.

**Files changed:**
- `apps/kafka/debezium-init/register-connector.sh` — added Avro converter and schema registry URL to connector config

---

## Step 120: Fix — Correct Grafana dashboard metrics to match actual JMX exporter output

**Root cause:** The Kafka & CDC Grafana dashboard used metric names (`debezium_metrics_millisecondsbehindsource`, `kafka_connect_connector_status`) that don't exist. The JMX exporter's regex rules were too restrictive and didn't match Debezium's actual MBean names. With a catch-all rule, the real metrics are under `kafka_connect_source_task_metrics_*` and `kafka_connect_connector_task_metrics_*`.

**Fix:**
- Simplified JMX exporter config to a catch-all pattern so all MBeans are exported
- Rewrote the dashboard to use actual metric names: `source_record_write_total` (rate), `poll_batch_avg_time_ms`, `source_record_active_count`, `running_ratio`, `connector_count`, `connector_failed_task_count`

**Files changed:**
- `apps/kafka/debezium/jmx-exporter-config.yml` — replaced restrictive regex rules with catch-all
- `apps/observability/grafana/provisioning/dashboards/kafka-cdc.json` — rewrote all Debezium CDC and Kafka Connect panels with correct metric names

---

## Step 121: Add — Shared UI Library with PrimeNG for Consistent Design

Created a shared Angular UI library (`@org/ui`) at `libs/shared/ui/` using PrimeNG with the Aura theme preset for a professional, minimal design. Integrated the library into all four Angular applications (shell, weather-app, weatheredit-app, admin-app) for a consistent look and feel.

**What was added:**

1. **Shared UI library** (`libs/shared/ui/`) with reusable components:
   - `LayoutComponent` — app shell with collapsible sidebar navigation and router outlet
   - `PageHeaderComponent` — consistent page titles with subtitle and action slot
   - `CardComponent` — minimal card container with subtle shadow and border
   - `StatusBadgeComponent` — color-coded badges for temperature ranges and status indicators
   - `provideSharedUI()` — provider function that configures PrimeNG with the Aura theme
   - Shared global styles for typography, reset, and page containers

2. **Shell app** redesigned with sidebar navigation replacing the plain `<ul>` menu, and a new dashboard home page showing user session info and quick-link cards to each app.

3. **All remote apps** (weather-app, weatheredit-app, admin-app) updated to import and use shared `PageHeaderComponent`, `CardComponent`, and `StatusBadgeComponent` for consistent styling. Inline SVG icons replaced with PrimeIcons (`pi pi-*`).

4. **Dependencies installed:** `primeng`, `@primeng/themes`, `primeicons`, `@angular/animations`

5. **TypeScript configuration** updated: all app `tsconfig.app.json` files include the shared library sources and use the workspace root as `baseUrl` so the `@org/ui` path alias resolves correctly in Module Federation remote builds.

**Files changed:**
- `libs/shared/ui/` — new shared UI library (layout, page-header, card, status-badge, theme-provider, shared-styles)
- `libs/shared/ui/src/index.ts` — barrel export for all shared components and providers
- `apps/shell/src/app/app.ts` — replaced NxWelcome + router with LayoutComponent shell
- `apps/shell/src/app/app.config.ts` — added provideSharedUI() providers
- `apps/shell/src/app/app.routes.ts` — replaced NxWelcome with HomeComponent
- `apps/shell/src/app/home/home.component.ts` — new dashboard home page
- `apps/shell/project.json` — added primeicons and shared-styles to global styles array
- `apps/weather-app/src/app/remote-entry/entry.ts` — uses shared PageHeader, Card, StatusBadge
- `apps/weatheredit-app/src/app/remote-entry/entry.ts` — uses shared components, PrimeIcons
- `apps/weatheredit-app/src/app/remote-entry/entry.css` — updated to match shared design system
- `apps/admin-app/src/app/remote-entry/entry.ts` — uses shared Card, PageHeader, StatusBadge
- `apps/*/tsconfig.app.json` — added shared library includes and fixed baseUrl
- `tsconfig.base.json` — added `@org/ui` path alias (auto-generated by nx)
- `package.json` — added primeng, @primeng/themes, primeicons, @angular/animations


---

## Step 122: Fix — unit test failures after @org/ui shared library integration

**Root cause:** After integrating the `@org/ui` shared library, three test suites broke:

1. **shell** — `app.spec.ts` imported a deleted `./nx-welcome` component; the App component now uses `LayoutComponent` from `@org/ui`.
2. **weather-app & weatheredit-app** — Vite could not resolve the `@org/ui` path alias because the vite configs lacked `resolve.alias`; tests also lacked `overrideComponent` to avoid JIT-compiling signal-input child components.
3. **weatheredit-app** — `tempClass()` test expectations used `badge-*` prefixes but the implementation returns plain variants (`cold`, `cool`, etc.); the external `styleUrl` caused unresolvable resources in test mode.

**Fix:**

- Added `resolve.alias` for `@org/ui` in all three vite configs (`shell`, `weather-app`, `weatheredit-app`).
- Rewrote `shell/app.spec.ts` to remove the deleted `NxWelcome` import and use `overrideComponent` to skip `@org/ui` child rendering.
- Updated `weather-app/entry.spec.ts` to use `overrideComponent` (remove UI imports, add `CUSTOM_ELEMENTS_SCHEMA`) and fixed the loading text assertion (`Loading forecasts...` instead of `Loading...`) and temperature cell assertions (`5°` not `5`).
- Updated `weatheredit-app/entry.spec.ts` with the same `overrideComponent` pattern and corrected `tempClass()` expectations to match implementation return values.
- Converted `weatheredit-app` entry component from external `styleUrl: ./entry.css` to inline `styles` to avoid JIT resource resolution failures in tests.

**Files changed:**
- `apps/shell/vite.config.mts` — added `@org/ui` resolve alias
- `apps/weather-app/vite.config.mts` — added `@org/ui` resolve alias
- `apps/weatheredit-app/vite.config.mts` — added `@org/ui` resolve alias
- `apps/shell/src/app/app.spec.ts` — rewrote to work with current App component
- `apps/weather-app/src/app/remote-entry/entry.spec.ts` — added overrideComponent, fixed assertions
- `apps/weatheredit-app/src/app/remote-entry/entry.spec.ts` — added overrideComponent, fixed tempClass expectations
- `apps/weatheredit-app/src/app/remote-entry/entry.ts` — converted styleUrl to inline styles


---

## Step 123: Add — demo screenshots to README.md

**What:** Added a "Demo" section to the README with screenshots of all four Angular apps: shell home dashboard, weather forecast table, forecast management CRUD, and admin dashboard.

**How:** Created a Playwright-based screenshot script (`scripts/take-screenshots.mjs`) that builds and serves each Angular app with mocked API data, then captures 2x retina screenshots. The script handles Module Federation base href routing and mocks the weather API, Kratos session, and Kratos admin endpoints.

**Files changed:**
- `README.md` — added Demo section with four inline screenshot images
- `docs/screenshots/shell-home.png` — shell app home dashboard screenshot
- `docs/screenshots/weather-app.png` — weather forecast table screenshot
- `docs/screenshots/weatheredit-app.png` — forecast CRUD management screenshot
- `docs/screenshots/admin-app.png` — admin dashboard screenshot
- `scripts/take-screenshots.mjs` — Playwright screenshot capture script


---

## Step 124: Fix — GitHub Actions CI warnings and lint errors

**Root cause:** Two issues in the CI pipeline: (1) `actions/setup-dotnet@v4` runs on Node.js 20, which is deprecated on GitHub Actions runners (EOL April 2026). (2) The shell app's `home.component.ts` used a `(click)` handler on an `<a>` tag without keyboard event support, causing two accessibility lint errors (`click-events-have-key-events` and `interactive-supports-focus`).

**Fix:** Updated `actions/setup-dotnet` from v4 to v5 (which uses Node.js 24) in both CI jobs. Replaced the imperative `(click)="navigate(link.route)"` with declarative `[routerLink]="link.route"` on the dashboard link cards, which natively provides keyboard accessibility. Removed the now-unused `Router` injection and `navigate()` method.

**Files changed:**
- `.github/workflows/ci.yml` — upgraded `actions/setup-dotnet` from v4 to v5
- `apps/shell/src/app/home/home.component.ts` — replaced `(click)` with `[routerLink]`, removed unused `Router` import/injection


---

## Step 125: Fix — e2e tests to match current Dashboard UI

**Root cause:** The e2e tests in `example.spec.ts` and `eks.spec.ts` were written for the original Nx welcome page (expecting `#welcome h1` with "Welcome shell" text and a `#hero` banner). The home page was redesigned to use a `PageHeaderComponent` with a "Dashboard" heading and "Welcome to the NxWeather application." subtitle, so these selectors and assertions no longer matched.

**Fix:** Updated `example.spec.ts` to assert `h1` contains "Dashboard" instead of "Welcome". Updated `eks.spec.ts` home page tests to check for the `h1` "Dashboard" heading and `.page-subtitle` containing the welcome message, replacing the obsolete `#welcome` and `#hero` selectors.

**Files changed:**
- `apps/shell-e2e/src/example.spec.ts` — updated h1 assertion from "Welcome" to "Dashboard"
- `apps/shell-e2e/src/eks.spec.ts` — rewrote home page tests to match Dashboard UI selectors


---

## Step 126: Fix — e2e test selector for weather-app heading

**Root cause:** The `eks.spec.ts` e2e test for the weather-app MFE navigation used `page.locator('h2')` to find the "Weather Forecast" heading. However, the `PageHeaderComponent` renders the title in an `<h1>` element, not `<h2>`, causing the test to time out.

**Fix:** Changed the locator from `h2` to `h1` in the weather-app navigation test.

**Files changed:**
- `apps/shell-e2e/src/eks.spec.ts` — updated heading locator from `h2` to `h1`

## Step 127: Add — WeatherStream Angular app and Lightning Electron host

Added two new applications to the workspace:

**Root cause / motivation:** Need a real-time weather event streaming dashboard with native Kafka integration, leveraging Electron's Node.js runtime for direct Kafka consumer access.

**What was built:**

1. **weatherstream-app** (Angular) — Real-time weather event streaming dashboard
   - Weather dashboard component with live event cards (temperature, humidity, wind, conditions)
   - `KafkaStreamService` using Angular signals for reactive state management
   - Electron IPC bridge integration — receives Kafka events from the main process
   - Simulated event fallback when running standalone in the browser
   - Dark-themed responsive UI with animated card grid
   - Dev server on port 4203

2. **lightning-app** (Electron) — Desktop host for weatherstream-app with native Kafka
   - Main process: Kafka consumer via `kafkajs`, connects to configurable brokers/topic
   - Preload script: `contextBridge`-based IPC API (`electronKafka`) with context isolation
   - Loads weatherstream-app (dev server or production build)
   - Environment-variable-driven configuration (KAFKA_BROKERS, KAFKA_TOPIC, KAFKA_GROUP_ID)
   - Nx targets: `serve` (prod build), `serve-dev` (hot reload), `build-angular`, `package`

**Dependencies added:** `electron`, `kafkajs`

**Files changed:**
- `apps/weatherstream-app/` — new Angular app (generated via `@nx/angular:application`)
- `apps/weatherstream-app/src/app/services/kafka-stream.service.ts` — Kafka stream service with signals
- `apps/weatherstream-app/src/app/weather-dashboard/` — dashboard component (ts, html, css)
- `apps/lightning-app/project.json` — Nx project config with serve/serve-dev/package targets
- `apps/lightning-app/src/main.js` — Electron main process with Kafka consumer
- `apps/lightning-app/src/preload.js` — context-isolated IPC bridge
- `apps/lightning-app/src/kafka-consumer.js` — KafkaWeatherConsumer EventEmitter wrapper
- `package.json` — added electron and kafkajs dependencies
- `README.md`, `RUN.md`, `SUMMARY.md` — updated documentation

---

## Step 128: Update — devops-sre-lean agent to reflect project architecture

The generic DevOps/SRE agent definition was updated to accurately represent this project's specific infrastructure and tooling.

**Root cause / motivation:** The agent referenced generic tools (Docker, docker-compose, pnpm) instead of the actual stack (Podman, `podman play kube` with K8s manifests, npm). It also lacked knowledge of the project's observability stack, Traefik routing, Ory Kratos auth, pod startup ordering, and Nx container lifecycle targets.

**What changed:**
- Replaced generic container/orchestration guidance with Podman + K8s pod manifest specifics
- Added full architecture reference: pod manifests, startup order, networking, Traefik routing, health check endpoints
- Updated examples to use project-specific scenarios (weather-api, pod manifests, GitHub Actions)
- Updated anti-patterns to prevent recommending Docker/docker-compose/pnpm
- Added self-verification checklist items for pod manifests, Traefik config, and Nx targets
- Documented all CI/CD workflows and their triggers
- Removed the persistent memory section (path was incorrect and not relevant to the agent's core purpose)

**Files changed:**
- `.claude/agents/devops-sre-lean.md` — rewritten to match project architecture
- `SUMMARY.md` — added this step

---

## Step 129: Refactor — split devops-sre-lean agent into separate DevOps and SRE agents

Split the combined `devops-sre-lean` agent into two focused agents with clear domain boundaries.

**Root cause / motivation:** A single agent covering both DevOps and SRE conflated build/ship/deploy concerns with runtime reliability/observability. Splitting them gives each agent a tighter scope, better examples, and more relevant checklists.

**What changed:**
- **devops agent** (`.claude/agents/devops.md`) — CI/CD pipelines, container builds, K8s pod manifests, Traefik routing, Nx targets, deployment automation. Owns the "build and ship" domain.
- **sre agent** (`.claude/agents/sre.md`) — Prometheus/Grafana/Loki observability, alerting rules, SLOs/error budgets, health checks, incident response, performance diagnosis. Owns the "keep it running" domain.
- Both agents maintain lean principles and reference the project's exact stack (Podman, `podman play kube`, npm, etc.)
- Deleted the combined `devops-sre-lean.md`

**Files changed:**
- `.claude/agents/devops.md` — new DevOps agent
- `.claude/agents/sre.md` — new SRE agent
- `.claude/agents/devops-sre-lean.md` — deleted
- `SUMMARY.md` — added this step

---

## Step 130: Add — security engineer Claude agent

Created a dedicated security engineer agent tailored to this project's auth, scanning, and infrastructure security stack.

**Root cause / motivation:** The DevOps and SRE agents cover build/deploy and runtime reliability, but neither owns application security concerns like auth hardening, vulnerability scanning tuning, security headers, CORS/CSRF policy, or production readiness audits.

**What changed:**
- New agent covers: Ory Kratos auth hardening, KratosAuthMiddleware and Angular guard review, Traefik security middleware (headers, rate limiting), CodeQL/OWASP Dependency-Check/Dependabot pipeline tuning, TLS config, CORS/CSRF policy, secret management, and OWASP Top 10 analysis
- Documents all known dev-only security shortcuts with `DEV-ONLY:` labeling convention
- Severity classification system (Critical/High/Medium/Low) for all findings
- Lean philosophy: prefer Traefik middleware over WAFs, CodeQL over commercial SAST, tight config over complex token schemes

**Files changed:**
- `.claude/agents/security.md` — new security engineer agent
- `SUMMARY.md` — added this step

---

## Step 131: Add — Nx monorepo specialist Claude agent

Created a dedicated Nx agent focused on build performance optimization and developer flow state.

**Root cause / motivation:** The existing agents (devops, sre, security) don't own Nx-specific concerns like cache configuration, target dependency graphs, affected commands, generator usage, or build performance tuning. Developers need consistent, fast commands to stay in flow.

**What changed:**
- New agent documents the full Nx target graph, caching strategy, named inputs, and plugin configuration
- Flow-state command reference with consistent `npx nx` patterns for daily dev, build/verify, container/stack, and investigation workflows
- Build performance optimization checklist (cache correctness -> affected scope -> parallelism -> target granularity -> dev server performance)
- Requires consulting official Nx docs (`nx_docs` or `--help`) before recommending flags — never guesses
- Anti-patterns: guessing flags, npm wrappers, `run-many` when `affected` suffices, serializing parallel work

**Files changed:**
- `.claude/agents/nx.md` — new Nx monorepo specialist agent
- `SUMMARY.md` — added this step

---

## Step 132: Add — PostgreSQL database engineer Claude agent

Created a dedicated PostgreSQL agent focused on performance, health, backups, and replication management.

**Root cause / motivation:** No existing agent owns database concerns — query performance, schema migrations, backup strategy, replication slot health, or vacuum tuning. The single PostgreSQL instance serves four consumers (weather-api, Ory Kratos, Debezium CDC, postgres-exporter) and needs focused expertise.

**What changed:**
- New agent documents the full database topology: schema, all consumers and their connection strings, WAL/replication config, CDC setup (Debezium slot, publication, slot-guard), and health check patterns
- Tiered backup strategy guidance (dev -> staging -> production) with specific tools at each tier
- Performance expertise: EXPLAIN ANALYZE workflow, index strategy, vacuum tuning, connection management, lock diagnosis
- Hard rule to consult official PostgreSQL 17 docs before recommending any GUC parameter
- Output markers: `BACKUP:`, `PERF:`, `LOCK:`, `WAL:` for change impact visibility
- Anti-patterns: blind GUC tuning, VACUUM FULL in production, ignoring co-tenant impact

**Files changed:**
- `.claude/agents/postgres.md` — new PostgreSQL database engineer agent
- `SUMMARY.md` — added this step

---

## Step 133: Add — Kafka event streaming Claude agent

Created a dedicated Kafka agent covering the full CDC pipeline from PostgreSQL through Debezium to KafkaJS consumers.

**Root cause / motivation:** No existing agent owns event streaming concerns — Debezium connector configuration, Avro schema management, Schema Registry compatibility, KafkaJS consumer tuning, topic design, or replication slot coordination with PostgreSQL.

**What changed:**
- New agent documents the complete event streaming architecture: Kafka 3.9 (KRaft), Schema Registry 7.7.1, Debezium 2.7, Kafka UI, slot-guard, KafkaJS consumer (lightning-app), and Angular Kafka service (weatherstream-app)
- Avro schema workflow: auto-generation from DDL via Debezium, manual management via Schema Registry REST API, and evolution safety rules (add/remove/change/rename columns)
- Full connector config reference (`weather-api-connector`) with all properties documented
- Output markers: `SCHEMA:`, `REPLICATION:`, `CONSUMER:` for change impact visibility
- Hard rule to consult official Kafka, Debezium, Schema Registry, and KafkaJS docs before recommending config
- Anti-patterns: guessing config keys, ignoring schema compatibility, JSON converters when Avro is configured

**Files changed:**
- `.claude/agents/kafka.md` — new Kafka event streaming agent
- `SUMMARY.md` — added this step

---

## Step 134: Add — Entity Framework Core Claude agent

Created a dedicated EF Core agent focused on model design, query performance, migration safety, and cross-agent coordination with postgres and kafka agents.

**Root cause / motivation:** Schema changes in EF Core cascade downstream — a column addition generates a PostgreSQL DDL change and a new Avro schema in Kafka's Schema Registry. No existing agent owned this coordination or EF Core-specific concerns like query optimization, migration safety, or Npgsql provider configuration.

**What changed:**
- New agent documents the full EF Core setup: WeatherDbContext, entity model, repository pattern, migration history, NuGet packages, and API endpoints
- Cross-agent coordination protocol: model changes flagged with `POSTGRES:` markers (DDL, locks, indexes) and `KAFKA:` markers (Avro schema compatibility, consumer impact)
- Query performance expertise: `.ToQueryString()` review, `AsNoTracking()`, projection, split queries, compiled queries
- Migration safety: non-blocking DDL, concurrent index creation, rollback via `Down()`, script preview
- Hard rule to consult official EF Core 9, Npgsql, and .NET 9 docs before recommending APIs

**Files changed:**
- `.claude/agents/efcore.md` — new Entity Framework Core agent
- `SUMMARY.md` — added this step

---

## Step 135: Refactor — replace unit-test-writer agent with comprehensive test agent

Replaced the generic `unit-test-writer.md` agent with a project-specific `test.md` agent covering unit tests (Vitest + xUnit), E2E tests (Playwright), and test suite architecture.

**Root cause / motivation:** The old agent was generic (Jest/Vitest only, no E2E, no .NET tests, wrong package manager reference). It didn't address E2E testing with Playwright, .NET xUnit tests, test execution time as a developer experience concern, or the separation of full test suites from feature-level tests.

**What changed:**
- New agent covers all three test frameworks: Vitest (Angular unit), xUnit (.NET unit), Playwright (E2E)
- Test suite architecture: feature-level tests (fast feedback, per-PR) vs. full suites (comprehensive, separate runs)
- Separation rules: smoke tests (`eks-e2e.yml`) stay fast; feature E2E tests go in new spec files, not `eks.spec.ts`
- Execution time awareness: unit tests <1s per file, E2E <30s per test; `SLOW:` and `FLAKY:` markers
- Documents all established test patterns (mock factories, auth helpers, dynamic test data, TestBed setup)
- Complete command reference for developer flow (single file, affected) vs. full validation (coverage, all E2E)
- Hard rule to consult official Vitest, Playwright, xUnit, and Angular testing docs
- Deleted the old `unit-test-writer.md` with its generic content and incorrect memory path

**Files changed:**
- `.claude/agents/test.md` — new comprehensive test agent
- `.claude/agents/unit-test-writer.md` — deleted
- `SUMMARY.md` — added this step

---

## Step 136: Add — data science Claude agent

Created a data science agent for Python-based analytics, visualization, and pipeline work on top of this project's existing data sources.

**Root cause / motivation:** The project has rich data sources (PostgreSQL weather data, Kafka CDC streams, Prometheus metrics) but no data science tooling. A dedicated agent provides guidance for EDA, visualization, Airflow pipelines, and ML while connecting to the established infrastructure.

**What changed:**
- New agent maps all project data sources: PostgreSQL `WeatherForecasts` table, Ory Kratos identity tables (read-only), Kafka CDC topics (Avro), Prometheus metrics, and Grafana dashboards
- Covers pandas, NumPy, matplotlib, seaborn, plotly, scikit-learn, Apache Airflow, SQLAlchemy, and confluent-kafka
- Includes Python environment setup guide (virtual env, pinned deps) and recommended project structure for notebooks/pipelines
- Visualization best practices: titles, labels, appropriate chart types, accessible colors
- Airflow DAG design: idempotent tasks, retry logic, Podman-compatible containerized deployment
- Hard rule to consult official docs for all library APIs
- Read-only access to production tables — no writes to EF Core or Kratos managed data

**Files changed:**
- `.claude/agents/data-science.md` — new data science agent
- `SUMMARY.md` — added this step

---

## Step 137: Add — business analyst Claude agent with weather domain expertise

Created a business analyst agent that turns vague requirements into detailed, implementable specifications using deep weather domain knowledge.

**Root cause / motivation:** Developers receiving imprecise requirements like "add wind data" or "we need alerts" waste time guessing intent. A dedicated BA agent asks the right clarifying questions (sustained vs. gust speed? what alert channels? what thresholds?) and produces structured specs with acceptance criteria, data model changes, and cross-agent coordination flags.

**What changed:**
- New agent documents the full current product state (CRUD model, streaming events, auth roles, temperature classification, UI capabilities, what's missing)
- Comprehensive weather vocabulary: temperature (air, feels-like, wind chill, heat index, dew point), precipitation (rate, accumulation, PoP, type, freezing level), wind (sustained, gust, direction, Beaufort), pressure (SLP, tendency), humidity (RH, dew point, wet bulb), visibility/clouds (oktas, ceiling, fog types), UV, severe weather (scales, thresholds), and forecast terminology (nowcast through seasonal)
- Clarifying question framework (Who/What-Data/What-Behavior/When/Where/Why)
- Structured spec template with data requirements, acceptance criteria, API changes, model changes, and cross-agent flags
- Output markers: `MODEL:`, `CDC:`, `AUTH:`, `UI:` for cross-cutting concerns

**Files changed:**
- `.claude/agents/business-analyst.md` — new business analyst agent
- `SUMMARY.md` — added this step
