# ReviewLens

Navigation-first pull request review for Azure DevOps, as a VS Code extension.
See [docs/SPEC.md](docs/SPEC.md) for the full specification and decision log.

## Status: M0 (skeleton + ADO connectivity)

Implemented:
- Clean 4-layer skeleton: `src/domain` · `src/app` · `src/infra` · `src/ui`
- PAT auth via SecretStorage (`ReviewLens: Sign in (PAT)`)
- `AdoClient` (azure-devops-node-api) — lists active pull requests
- "Pull Requests" tree view in the ReviewLens activity-bar container

## Develop

```bash
npm install
npm run build      # esbuild bundle -> dist/extension.js
npm run typecheck  # tsc --noEmit
```

Press `F5` (Run ReviewLens) to launch the Extension Development Host.

## Configure

In Settings (or `.vscode/settings.json` of the host window):
- `reviewlens.orgUrl` — e.g. `https://dev.azure.com/your-org`
- `reviewlens.project` — project name
- `reviewlens.repository` — optional, to filter to one repo

Then run **ReviewLens: Sign in (PAT)** (scope: Code Read & Write) and the PR list loads.

## Layout

```
src/
  domain/   models & types (pure, no vscode/ADO deps) — SPEC §8
  app/      use-cases (PullRequestService)
  infra/    external I/O (config, ADO client, PAT auth)
  ui/       tree views, commands
  common/   logger
```
