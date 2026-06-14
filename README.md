# ReviewLens

Navigation-first pull request review for Azure DevOps, as a VS Code extension.
See [docs/SPEC.md](docs/SPEC.md) for the full specification and decision log.

## Features

- **PR list** — active pull requests for the configured org/project, grouped by
  **project → repository**, with a free-text **filter** (title, author, repo,
  project, branch) from the view toolbar.
- **Review a PR** — click a PR to load its changed files; click a file to open a
  **base ↔ head diff** (read-only virtual documents).
- **Local review** (opt-in) — check out the PR's head commit into an isolated
  git **worktree** and review against it, so the head side of the diff is a real
  file with full code intelligence: **go-to-definition, find references, grep,
  and opening any neighboring file**. The lightweight ADO-only diff remains the
  default; turn local review on from the Changed Files toolbar
  (**Review locally**). Comments and **Impact analysis** retarget to the
  checkout automatically.
- **Comments** — ADO comment threads render inline on the head side; create,
  reply, and resolve, all round-tripping to ADO. Commenting is allowed on every
  line, so unchanged context can be annotated too. Start a comment on the
  current line with `ctrl+;` (`cmd+;` on macOS) and submit it with
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
- `reviewlens.localRepoPath` — optional, absolute path to a local clone for
  local review. Empty = auto-detect from open workspace folders by matching the
  repo's remote URL.

Run **ReviewLens: Sign in (PAT)** (scope: Code Read & Write); the PAT is stored
in SecretStorage.

## Keybindings (when a review is active)

| Action | Key |
|---|---|
| Next / previous changed file | `shift+alt+]` / `shift+alt+[` |
| Next / previous change in diff | `alt+down` / `alt+up` |
| Add comment on current line | `ctrl+;` (`cmd+;` on macOS) |
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
- **AI** (PR summary / risk / hunk explanation) — Phase 3.

### Local review notes / limitations

- Requires a local clone of the repo (auto-detected from open workspace folders,
  or set `reviewlens.localRepoPath`). The PR's head commit is fetched if absent.
- The worktree is **detached** and created under the extension's global storage,
  so it never moves your branch or touches your working tree. It's reused across
  iterations with the same head commit; worktrees are not yet auto-pruned.
- The head file is a real, editable document — editing it will drift comment
  anchors. Treat it as read-only while reviewing.
- Starting local review requires at least one folder open (the worktree is added
  as an extra workspace folder so the language server indexes the head version).
