<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

## Module Federation

This monorepo uses Angular Module Federation (shell + remotes). Key gotchas:

- **Use signals, not plain properties, for reactive state in remote components.** HTTP subscribe callbacks can run outside Angular's zone in the MF context, so zone-based change detection won't trigger. Signals push notifications directly and always work. See `weather-app/src/app/remote-entry/entry.ts` for the correct pattern.
- **Proxy all backend API calls through Traefik** (relative paths like `/.ory/kratos/admin/...`). Never call backend ports directly (e.g., `http://localhost:4434`) from browser code — this causes CORS errors since the app is served from `https://localhost:8443`.
- Traefik routes and strip-prefix middleware are in `traefik/traefik-dynamic.yml`.

## SUMMARY.md

- **Always update `SUMMARY.md` before committing.** Every non-trivial change (bug fix, feature, config change, workflow update) must be documented as a new numbered step.
- Follow the existing format: `## Step N: <verb> — <short description>`, then root cause, fix, and files changed.
- Do this proactively — do not wait to be asked.
