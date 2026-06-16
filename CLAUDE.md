# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ReviewLens is a **VS Code extension** for reviewing **Azure DevOps Repos** pull
requests from inside the editor (navigation-first review). It is TypeScript,
bundled with esbuild, and depends only on `vscode` (peer) and
`azure-devops-node-api`. There is no marketplace publish — releases attach a
`.vsix` to a GitHub Release. The full spec and decision log is `docs/SPEC.md`
(written in Japanese); the decision IDs (D1–D12, FR-xx) referenced in code
comments live there.

## Commands

```bash
npm install
npm run build      # esbuild bundle -> dist/extension.js (also dist/test/suggestion.js)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit (the only type-check; build does NOT type-check)
npm test           # runs `npm run build` (pretest) then @vscode/test-electron
npm run package    # vsce package -> reviewlens-<version>.vsix
```

- **Type errors are only caught by `npm run typecheck`.** esbuild strips types
  without checking them, so run typecheck before considering a change done.
- **There is no linter and no formatter config** — match the surrounding style.
- Press `F5` ("Run ReviewLens" launch config) to debug in an Extension
  Development Host.
- `scripts/verify-ado.js` is a manual probe against a real ADO org (set
  `ADO_PAT`, `ADO_PROJECT`, `ADO_ORG`); use it to confirm API/field mappings
  without launching the extension.

### Tests

`test/runTest.js` boots a VS Code instance and runs everything matching
`test/suite/**/*.test.js` via Mocha (BDD). Three kinds of test exist:

- **Activation tests** (`extension.test.js`) need the VS Code host — they assert
  the extension activates and registers its commands/views.
- **Pure-logic tests** (`suggestion.test.js`, `navigation.test.js`,
  `navigationCursor.test.js`, `anchor.test.js`, `adoClient.test.js`) `require`
  from `dist/test/`, not `src/`. This is why `esbuild.js` emits *extra* standalone
  bundles, one per entry in `testEntries` (e.g. `src/domain/suggestion.ts` ->
  `dist/test/suggestion.js`): the unit tests can't reach into the bundled
  extension, so vscode-free helpers are re-bundled standalone. **If you add a
  unit-testable pure helper, add an entry to `testEntries` in `esbuild.js`** (each
  gets its own flat `dist/test/<name>.js`) or the test won't be able to import it.
  `adoClient.ts` keeps `azure-devops-node-api` external so its bundle stays small.
  The pattern for testing vscode-coupled logic is to extract the pure core into
  `domain/` and leave a thin wrapper (e.g. `domain/navigation.ts` backs
  `extension.ts`'s comment jump; `domain/anchor.ts` backs the FR-10 re-anchor in
  `ui/commentsController.ts`).
- **Live E2E** (`ado.e2e.test.js`) drives the real `AdoClient` against a real PR.
  It is `describe.skip`ped unless `ADO_PAT` is set, so `npm test` and CI stay
  offline. Read checks run with just `ADO_PAT`; write checks (comment/vote, with
  create+cleanup) are gated behind `ADO_E2E_WRITE=1`. Target is overridable via
  `ADO_ORG`/`ADO_PROJECT`/`ADO_REPO`/`ADO_E2E_BRANCH`/`ADO_E2E_PR`. Note: MSA-backed
  orgs reject AAD bearer tokens (TF400813) — a PAT is required.

Tests are plain JS (`.js`, not `.ts`). To run a single test, narrow with Mocha
grep, e.g. `node test/runTest.js` after editing the suite, or temporarily use
`.only` in the spec.

### UI walkthrough (`npm run test:ui`)

`test/ui/*.ui.test.js` is a separate suite run by **ExTester**
(`vscode-extension-tester`), *not* the `npm test` runner. It launches a real
VS Code window over WebDriver, attaches to a live PR, drives the navigation
commands, and screenshots each step into `test-resources/screenshots/<ts>/` so
the diff/comment jumps can be verified visually. It is the only test that
exercises VS Code's own diff editor (e.g. `nextChange`'s roll-over to the next
file), which the pure tests can't reach.

- Needs `ADO_PAT` and a workspace checked out on the PR's **source branch**
  (branch-attach keys off the open branch). `scripts/ui-verify.ps1` clones the
  fixture PR's branch into a temp dir and runs the suite; or set `RL_UI_WORKSPACE`
  to your own checkout. Without `ADO_PAT` the suite self-skips.
- `extest setup-and-run` downloads VS Code + ChromeDriver into `test-resources/`
  (gitignored) on first run and packages/install the extension, so the first run
  is slow. Settings are injected from `test/ui/settings.json`.
- Gotcha: recent VS Code shows a Copilot **onboarding overlay**
  (`div.onboarding-a-overlay`) that ignores Escape and intercepts clicks; the
  suite's `dismissModals()` closes it via the DOM before running commands. If new
  VS Code versions block again, that helper is where to look.

## Architecture

A clean 4-layer architecture (SPEC §7). Dependencies point inward only:
`ui` → `app` → `infra` → `domain`. `domain` imports nothing project-specific.

```
src/
  domain/   Pure data shapes & enums. NO vscode/ADO imports (models.ts, types.ts,
            errors.ts). suggestion.ts holds pure, unit-tested helpers.
  app/      Use-cases. reviewService.ts is the single stateful holder of the PR
            currently under review (the ActiveReview object).
  infra/    Side-effects: ado/ (azure-devops-node-api wrapper + PAT auth +
            client cache), git/repo.ts (shells out to `git`), config.ts (reads
            settings), state/ (workspaceState-backed stores).
  ui/       VS Code surface: tree view, diff virtual docs, comment threads,
            keyboard navigation.
  extension.ts  Composition root — wires everything and registers all commands.
```

Key boundaries to preserve:

- **All ADO REST access goes through `infra/ado/adoClient.ts`.** It is the only
  place that imports `azure-devops-node-api` and the only place that knows ADO's
  encodings (e.g. votes as `10/5/0/-5/-10`, `threadContext` line/offset, leading-
  slash path quirks). Map to/from the `domain` types at this boundary — don't
  leak ADO interfaces upward.
- **`clientFactory.createAdoClient` caches one `AdoClient`** keyed on config+PAT.
  The first request per connection pays a resource-area lookup; rebuilding the
  client per action would pay it every time. Get the client through the factory,
  not by `new AdoClient(...)`.
- **`ReviewService` owns review state.** `extension.ts` and the UI read the
  current PR, files, threads, and content cache through it. It exposes
  `localPath` (the head-side working-tree root in branch-attach mode) which
  several URI/anchor decisions key off.

### The core model: "branch attach" (read this before changing review flow)

The shipped review flow is **not** a separate PR-list-then-open flow. It works
off the **branch the workspace is checked out on**:

1. On activation / editor switch / branch change, `maybeAutoAttach` (in
   `extension.ts`) resolves the open repo's current branch and asks ADO for the
   active PR whose *source branch* matches (`findActivePrBySourceBranch`).
2. If found, `ReviewService.setLocalPath(repoRoot)` points review at the open
   working tree. The working-tree files **are** the head side — comments render
   inline on the real files (full code intelligence, no diff editor required),
   and `maybeAutoDiff` swaps a changed file into a base↔head diff when opened.
3. `attachedBranchKey` is `${repoRoot}#${branch}`; `autoTriedKey` remembers the
   last branch queried (even if no PR) so a branch with no PR isn't re-queried
   on every editor switch. Both reset on branch change.

A background poll (`startSync`, interval = `reviewlens.syncInterval` seconds)
re-fetches threads so others' comments appear without manual refresh;
`threadsSignature` (in `domain/suggestion.ts`) gates re-renders to actual
changes.

### Head-side document URIs

There are two kinds of "head" document, decided in `ui/diffContentProvider.ts`:

- **Real file** (`file:` scheme) when `localPath` is set and the file exists on
  disk — used in branch-attach mode so the head pane is editable and has code
  intelligence.
- **Virtual doc** (`reviewlens:` scheme, `DIFF_SCHEME`) served by
  `DiffContentProvider` from the ADO content API — the fallback when there's no
  local file.

`headUri` / `headDocPath` / `sideUri` / `parseRightUri` convert between them.
`CommentsController.headPath` is the gate for "may we comment here?" — in local
mode it restricts commenting to the PR's *changed* files so neighboring files
opened for context don't get comment gutters.

### Comment anchoring & drift (FR-10)

Comments anchor to a head-side line, but later pushes shift lines. `AnchorStore`
(`infra/state/anchorStore.ts`) persists, per PR/thread, the *normalized text* of
the anchored line in `workspaceState`. On render, `resolveAnchorLine`
(`ui/commentsController.ts`) re-anchors: if the stored line's text still matches,
use it (`none`); else search ±`REANCHOR_WINDOW` lines for the remembered text
(`moved`, flagged `↕`); else keep the stored line (`lost`, flagged `⚠`). When
changing comment rendering, keep this re-anchoring path and the opportunistic
baselining of snapshot-less threads.

### Suggestions

A suggestion is an ordinary ADO comment whose body contains a
` ```suggestion ` fenced block. `domain/suggestion.ts:extractSuggestion` parses
it; the thread gets a `.suggestion` contextValue so the "Apply" title action
appears. `applySuggestion` only works in branch-attach mode (the head doc must
be the real editable `file:` document).

## Conventions

- **Settings live in two places that must agree:** the `contributes.*` blocks in
  `package.json` (commands, keybindings, `when` clauses, configuration) and the
  code in `extension.ts` / `infra/config.ts`. The activation test asserts the
  declared command list, so adding a command means updating `package.json`,
  registering it in `extension.ts`, and adding it to the test's id list.
- **Actual configuration keys** (package.json is the source of truth):
  `reviewlens.orgUrl`, `reviewlens.project`, `reviewlens.repository`,
  `reviewlens.autoAttachBranchPr`, `reviewlens.syncInterval`.
- **Auth is PAT-only** (SPEC D6), stored in `SecretStorage` via `AuthProvider`.
  No Microsoft auth provider. Reading needs scope Code (Read & Write); work-item
  titles additionally need Work Items (Read) and degrade to id-only without it.
- Error handling pattern: infra throws typed errors (`domain/errors.ts`:
  `NotConfiguredError`, `NotSignedInError`); commands catch and surface via
  `vscode.window.show*Message`; the background sync swallows transient errors.
- Comments in this codebase explain **why**, often citing SPEC decision IDs.
  Match that — terse rationale over restating the code.

## ⚠️ README vs. reality

`README.md` and `docs/SPEC.md` describe a larger product than the current code:
**PR list view (grouped by project→repo)**, **local worktree review**,
**impact analysis**, and the settings `reviewlens.baseRef`,
`reviewlens.localRepoPath`, `reviewlens.localWorktreeLimit`. **None of these
exist in `src/` yet** — they are not contributed in `package.json` and have no
implementation. The shipped behavior is the branch-attach model above; the only
contributed view is `reviewlens.changedFiles`. Treat README/SPEC as the roadmap,
not a description of current behavior, and prefer `package.json` + `src/` when
they disagree. (Early prototypes of some of these live in `spike/`, which is not
part of the build.)

## Release

Releasing is tag-driven: pushing a `v*` tag runs `.github/workflows/release.yml`,
which packages the `.vsix` and attaches it to a GitHub Release. There is a
`release` skill (`.claude/skills/release/`) that walks the full procedure (bump
`package.json`, verify, commit, tag `vX.Y.Z` matching the version) — use it when
asked to cut a release.
