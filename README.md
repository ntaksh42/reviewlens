# ReviewLens

Navigation-first pull request review for Azure DevOps, as a VS Code extension.
See [docs/SPEC.md](docs/SPEC.md) for the full specification and decision log.

## Features

- **PR list** — active pull requests for the configured org/project, grouped by
  **project → repository**, with a free-text **filter** (title, author, repo,
  project, branch) from the view toolbar.
- **Review a PR** — click a PR to load its changed files; click a file to open a
  **base ↔ head diff** (read-only virtual documents).
- **Comments** — ADO comment threads render inline on the head side; create,
  reply, and resolve, all round-tripping to ADO. Commenting is allowed on every
  line, so unchanged context can be annotated too. Start a comment on the
  current line with `ctrl+alt+c` (`cmd+alt+c` on macOS) and submit it with
  `ctrl+enter` (`cmd+enter` on macOS) — no mouse required.
- **Viewed** — toggle a file as viewed (persisted per PR).
- **Impact analysis** (the differentiator) — for each changed function, list its
  callers and flag the ones **not changed in this PR** (the blast radius). Runs
  on the open repository via the active language server.
- **Keyboard navigation** — jump between changed files and between diff changes.

## Develop

```bash
npm install
npm run build      # esbuild bundle -> dist/extension.js
npm run typecheck  # tsc --noEmit
npm test           # @vscode/test-electron activation test
```

Press `F5` (Run ReviewLens) to launch the Extension Development Host.

## Configure

In Settings of the host window:
- `reviewlens.orgUrl` — e.g. `https://dev.azure.com/your-org`
- `reviewlens.project` — project name
- `reviewlens.repository` — optional, to filter to one repo
- `reviewlens.baseRef` — base ref for impact analysis (default `main`)

Run **ReviewLens: Sign in (PAT)** (scope: Code Read & Write); the PAT is stored
in SecretStorage.

## Keybindings (when a review is active)

| Action | Key |
|---|---|
| Next / previous changed file | `shift+alt+]` / `shift+alt+[` |
| Next / previous change in diff | `alt+down` / `alt+up` |
| Add comment on current line | `ctrl+alt+c` (`cmd+alt+c` on macOS) |
| Submit comment | `ctrl+enter` (`cmd+enter` on macOS) |

## Layout

```
src/
  domain/   models & types (pure) — SPEC §8
  app/      use-cases (PullRequestService, ReviewService)
  infra/    ADO client + auth + config, viewed store, impact analyzer (LSP)
  ui/       tree views, diff/virtual-doc, comments, navigation
  common/   logger
```

## Not yet implemented

- **Suggested edits** (FR-23) — ADO has no native suggestion UI; deferred.
- **Local checkout** — the diff uses the ADO content API; checking out the PR
  branch (for go-to-definition / grep on the diff itself) is deferred to when
  impact analysis is wired to the PR flow (currently it runs on the open repo).
- **AI** (PR summary / risk / hunk explanation) — Phase 3.
