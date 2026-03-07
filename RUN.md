# Running the Project

All commands are run from the workspace root (`claude-hello-world/`).

---

## Development

### Serve all apps locally (hot reload)

```bash
npx nx serve shell --devRemotes=page1,page2
```

Starts the Module Federation dev server for the shell on port 4200. `--devRemotes` tells Nx to also start live webpack dev servers for page1 (port 4201) and page2 (port 4202) rather than serving their static builds. Changes in any app trigger a live reload in the browser.

| App | URL |
|-----|-----|
| Shell (host) | http://localhost:4200 |
| page1 (remote) | http://localhost:4201 |
| page2 (remote) | http://localhost:4202 |

### Serve shell only (remotes served as static builds)

```bash
npx nx serve shell
```

Starts only the shell dev server. The remotes must have been built previously — the shell loads them from their static `dist/` output rather than live dev servers. Useful when you are only changing shell code.

### Serve a single remote app

```bash
npx nx serve page1
npx nx serve page2
```

Starts a standalone dev server for one remote at its port (4201 or 4202). Depends on `shell:serve` being running. Primarily useful for isolated component development or debugging a remote in isolation.

---

## Building

### Build a single app (production)

```bash
npx nx build shell
npx nx build page1
npx nx build page2
```

Runs a production webpack build for one app. Output lands in `dist/apps/<name>/`. The default configuration is `production` (optimized, hashed filenames, no source maps). page1 and page2 builds include `baseHref` set to `/page1/` and `/page2/` respectively for correct asset resolution when served from sub-paths.

### Build a single app (development)

```bash
npx nx build shell --configuration=development
npx nx build page1 --configuration=development
npx nx build page2 --configuration=development
```

Runs a development build with source maps, named chunks, and no optimization. Faster than production and easier to debug — the `dist/` output can be inspected directly with readable filenames.

### Build all apps in parallel (production)

```bash
npx nx build-all shell
```

Runs production builds for shell, page1, and page2 in parallel (`--parallel=3`). This is the same build step that `podman-build` triggers automatically as a dependency. Outputs to:
- `dist/apps/shell/`
- `dist/apps/page1/`
- `dist/apps/page2/`

---

## Testing and Linting

### Run unit tests for one app

```bash
npx nx test shell
npx nx test page1
npx nx test page2
```

Runs Vitest unit tests for the specified app. Coverage reports are written to `coverage/apps/<name>/`.

### Run unit tests for all apps

```bash
npx nx run-many --target=test --all
```

Runs Vitest for every project in the workspace in parallel. Nx caches test results — only re-runs tests for projects whose files have changed since the last run.

### Lint one app

```bash
npx nx lint shell
npx nx lint page1
npx nx lint page2
```

Runs ESLint for the specified app using the project's `eslint.config.mjs`. Reports rule violations and any TypeScript type errors caught by the linter.

### Lint all apps

```bash
npx nx run-many --target=lint --all
```

Lints every project in the workspace in parallel.

---

## Container (Podman)

### Build the Podman image

```bash
npx nx podman-build shell
```

First runs `build-all` (production builds for all three apps), then runs:

```
podman build -t claude-hello-world -f Containerfile .
```

The multi-stage `Containerfile` compiles the apps inside a `node:20-alpine` container and copies the outputs into an `nginx:alpine` image. The resulting image is tagged `localhost/claude-hello-world:latest`.

To verify the image was created:

```bash
podman images | grep claude-hello-world
```

### Start the container

```bash
npx nx podman-up shell
```

Runs `podman run -d` to start the `claude-hello-world` container in detached mode, mapping port 8080 on the host to port 80 in the container. The image must have been built first with `podman-build`.

| URL | Serves |
|-----|--------|
| http://localhost:8080 | Shell (host app) |
| http://localhost:8080/page1/ | page1 remote |
| http://localhost:8080/page2/ | page2 remote |
| http://localhost:8080/page1/remoteEntry.mjs | page1 Module Federation entry point |
| http://localhost:8080/page2/remoteEntry.mjs | page2 Module Federation entry point |

### Stop the container

```bash
npx nx podman-down shell
```

Runs `podman rm -f claude-hello-world`, forcibly stopping and removing the container. The image is preserved — you can restart with `podman-up` without rebuilding.

---

## Nx Workspace Utilities

### View all targets for a project

```bash
npx nx show project shell
npx nx show project page1
npx nx show project page2
```

Prints all available targets (build, serve, test, lint, podman-build, etc.) for the given project along with their executor and options.

### Visualize the project graph

```bash
npx nx graph
```

Opens a browser-based interactive graph showing all projects in the workspace and their dependencies. Useful for understanding how the shell depends on its remotes and which projects are affected by a given change.

### See what is affected by current changes

```bash
npx nx affected --target=build
npx nx affected --target=test
```

Compares the current working tree against the base branch and runs the specified target only for projects that are affected by the changes. Speeds up CI pipelines significantly in larger monorepos.

### Clear the Nx build cache

```bash
npx nx reset
```

Deletes the local `.nx/cache` directory. Run this if builds are returning unexpected cached results or after significant dependency changes.
