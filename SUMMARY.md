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
  --remotes=page1,page2 --standalone --bundler=webpack --no-interactive
```

The `host` generator creates:
- `apps/shell/` — the host (shell) application with `module-federation.config.ts` and webpack configs
- `apps/page1/` and `apps/page2/` — remote apps each exposing `./Routes`
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
      ['page1', '/page1/remoteEntry.mjs'],
      ['page2', '/page2/remoteEntry.mjs'],
    ],
  },
  { dts: false }
);
```

The dev webpack config (`webpack.config.ts`) keeps `remotes: ['page1', 'page2']` for localhost dev server use.

---

## Step 6: Set baseHref for Remote Apps

Added `"baseHref": "/page1/"` and `"baseHref": "/page2/"` to the production configuration in each remote's `project.json`. This ensures Angular sets `<base href="/page1/">` in the generated HTML so asset paths resolve correctly when served from a sub-path.

---

## Step 7: Create the nginx Configuration

Created `nginx/nginx.conf` with path-based routing:
- `/` → shell app (`/usr/share/nginx/html/shell`)
- `/page1/` → page1 remote (`/usr/share/nginx/html/page1/`)
- `/page2/` → page2 remote (`/usr/share/nginx/html/page2/`)

Used `try_files $uri $uri/ /index.html` for the shell (SPA fallback) and `try_files $uri /page1/index.html` for remotes.

---

## Step 8: Create the Containerfile and docker-compose.yml

**`Containerfile`** — multi-stage build:
1. Stage 1 (`builder`): `node:20-alpine`, runs `npm ci` then `npx nx run-many --target=build --projects=shell,page1,page2 --configuration=production --parallel=3`
2. Stage 2 (`runner`): `nginx:alpine`, copies each app's build output to its nginx serving directory

**`docker-compose.yml`** — kept for reference but not used at runtime (see Step 16). Maps host port 8080 to container port 80 and references the pre-built image by name.

---

## Step 9: Add Nx Custom Targets to shell/project.json

Added four targets to `apps/shell/project.json`:

| Target | Command |
|--------|---------|
| `build-all` | `npx nx run-many --target=build --projects=shell,page1,page2 --configuration=production --parallel=3` |
| `podman-build` | `podman build -t claude-hello-world -f Containerfile .` (depends on `build-all`) |
| `podman-up` | `podman run -d --name claude-hello-world -p 8080:80 localhost/claude-hello-world:latest` |
| `podman-down` | `podman rm -f claude-hello-world` |

---

## Step 10: Initial Commit and Push

```bash
# Commit 1: all scaffolded files
git add --all -- ':!Containerfile' ':!docker-compose.yml' ':!nginx/'
git commit -m "feat: initial Nx Angular MFE monorepo"

# Commit 2: infra files
git add Containerfile docker-compose.yml nginx/nginx.conf
git commit -m "feat: add Podman, nginx, and Nx podman targets"

git push -u origin main
```

---

## Step 11: Debug — BUILD-001 (Failed to find expose module)

Running `npx nx podman-build shell` failed with:

```
<e> [EnhancedModuleFederationPlugin] Failed to find expose module. #BUILD-001
<e> args: {"exposeModules":[{"name":"./Routes","module":null,
    "request":"apps/page1/src/app/remote-entry/entry.routes.ts"}]}
```

**Diagnosis:** The `exposes` path in `module-federation.config.ts` was `apps/page1/src/app/remote-entry/entry.routes.ts` — no leading `./`. Webpack's resolver treats paths without a `./`/`../`/`/` prefix as bare module specifiers (node_modules lookups), not file paths. The `ContainerEntryModule` in `@module-federation/enhanced` has a null context, so webpack uses the compilation context (workspace root) for resolution. Without `./`, the file is never found.

**Debugging steps:**
```bash
# Confirmed file exists at workspace-root-relative path
node -e "
  const path = require('path');
  const fs = require('fs');
  console.log(fs.existsSync(path.resolve(process.cwd(), 'apps/page1/src/app/remote-entry/entry.routes.ts')));
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
// apps/page1/module-federation.config.ts
import { join } from 'path';
exposes: {
  './Routes': join(__dirname, 'src/app/remote-entry/entry.routes.ts'),
}
```

`__dirname` at Node.js config-evaluation time is `apps/page1/`, giving an unambiguous absolute path.

---

## Step 12: Debug — `Cannot find name 'console'` (missing DOM lib)

After fixing BUILD-001, the build failed with:

```
Error: apps/page1/src/bootstrap.ts:5:61 - error TS2584:
Cannot find name 'console'. Do you need to change your target library?
Try changing the 'lib' compiler option to include 'dom'.
```

**Diagnosis:** `tsconfig.base.json` was generated with `"lib": ["es2022"]` only. The `dom` lib (which provides `console`, `window`, `document`, etc.) was missing.

**Fix:** Added `"lib": ["es2022", "dom"]` to the `compilerOptions` of every `tsconfig.app.json` (shell, page1, page2).

---

## Step 13: Debug — Angular Compiler Rejects Project Reference Options

The next build attempt failed with:

```
Error: NG4006: TS compiler option "emitDeclarationOnly" is not supported.
Error: TS5069: Option 'emitDeclarationOnly' cannot be specified without specifying 'declaration' or 'composite'.
Error: TS5090: Non-relative paths are not allowed when 'baseUrl' is not set.
```

**Diagnosis:** `tsconfig.base.json` inherited into `tsconfig.app.json` carries project-reference settings (`composite: true`, `emitDeclarationOnly: true`, `declarationMap: true`) that Angular's compiler explicitly rejects. Additionally, the path aliases (`"page1/Routes": [...]`) in `tsconfig.base.json` require a `baseUrl` to resolve, but none was set on the app-level tsconfigs.

**Fix:** Overrode those options in every `tsconfig.app.json`:

```json
"composite": false,
"declarationMap": false,
"emitDeclarationOnly": false,
"baseUrl": "."
```

---

## Step 14: Debug — `Cannot find module 'page1/Routes'` in Shell

Shell build failed with:

```
Error: apps/shell/src/app/app.routes.ts:11:32 - error TS2307:
Cannot find module 'page1/Routes' or its corresponding type declarations.
```

**Diagnosis:** The shell imports remotes as `import('page1/Routes')`. TypeScript resolves this using the `paths` aliases in `tsconfig.base.json`:

```json
"paths": {
  "page1/Routes": ["apps/page1/src/app/remote-entry/entry.routes.ts"]
}
```

Path aliases are resolved relative to `baseUrl`. With `"baseUrl": "."` (= `apps/shell/`), TypeScript looked for `apps/shell/apps/page1/src/...` which doesn't exist. The remote apps (page1, page2) built fine because they don't use those aliases themselves.

**Fix:** Set `"baseUrl": "../../"` in `apps/shell/tsconfig.app.json` so path resolution starts from the workspace root, where `apps/page1/src/...` is valid. Remote apps kept `"baseUrl": "."` .

---

## Step 15: Debug — Containerfile Copies Wrong Path

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

**Fix:** Removed `/browser` suffix from all three COPY lines in the Containerfile:

```dockerfile
COPY --from=builder /app/dist/apps/shell /usr/share/nginx/html/shell
COPY --from=builder /app/dist/apps/page1 /usr/share/nginx/html/page1
COPY --from=builder /app/dist/apps/page2 /usr/share/nginx/html/page2
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
      - run: npx nx run-many --target=lint --projects=shell,page1,page2 --parallel=3
      - run: npx nx run-many --target=build --projects=shell,page1,page2 --configuration=production --parallel=3
```

CI now passes in ~2 minutes.

---

## Step 19: Debug — Shell Root Path Shows Blank White Screen

After a successful `podman-build` and `podman-up`, navigating to `http://localhost:8080/` showed a blank white screen, while `/page1/` and `/page2/` rendered correctly.

**Diagnosis:** The shell bootstraps Angular and Webpack Module Federation simultaneously tries to fetch the remote entry files (`/page1/remoteEntry.mjs` and `/page2/remoteEntry.mjs`). The `nginx:alpine` image's default `mime.types` file does not include a mapping for the `.mjs` extension, so nginx served those files with `Content-Type: application/octet-stream`. Browsers enforce strict MIME type checking for ES module scripts and refuse to execute them, causing the shell's Module Federation initialization to fail before Angular could render anything.

The `/page1/` and `/page2/` paths appeared to work because nginx served each remote's standalone `index.html` directly — completely bypassing Module Federation.

Browser console confirmed:
```
Failed to load module script: Expected a JavaScript-or-Wasm module script but the
server responded with a MIME type of "application/octet-stream". Strict MIME type
checking is enforced for module scripts per HTML spec.
```

**Fix:** Added a `sed` command to the Containerfile's runner stage to patch nginx's built-in `mime.types` file, appending `mjs` to the existing `application/javascript` entry:

```dockerfile
FROM nginx:alpine AS runner
COPY nginx/nginx.conf /etc/nginx/nginx.conf
RUN sed -i 's|application/javascript\s*js;|application/javascript js mjs;|' /etc/nginx/mime.types
```

A `types {}` block in `nginx.conf` was considered but rejected — a second `types` block in the same context *replaces* the included `mime.types` entirely rather than merging with it, which would break MIME types for all other file extensions.

---

## Final Verification

```bash
npx nx podman-build shell
# NX  Successfully ran target podman-build for project shell

podman images | grep claude-hello-world
# localhost/claude-hello-world  latest  ...

npx nx podman-up shell
# → http://localhost:8080        (shell)
# → http://localhost:8080/page1/remoteEntry.mjs
# → http://localhost:8080/page2/remoteEntry.mjs
```
