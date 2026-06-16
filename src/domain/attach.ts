/**
 * Pure helpers for the "branch attach" review flow (see CLAUDE.md). The flow's
 * side effects (git, ADO, VS Code) live in `extension.ts`; the bookkeeping that
 * decides *whether* to act is here so it can be unit-tested without a host.
 */

/** The key identifying an attached review: a repo root and the branch on it. */
export function branchKey(repoRoot: string, branch: string): string {
  return `${repoRoot}#${branch}`;
}

/**
 * Whether the auto path should query ADO for `key`. It skips when the branch is
 * already attached, or was already tried and found no PR — so an editor switch
 * within the same branch doesn't re-query on every event. A branch switch
 * changes `key`, so it gets tried again.
 */
export function shouldAutoAttach(
  key: string,
  attachedBranchKey: string | undefined,
  autoTriedKey: string | undefined
): boolean {
  return key !== attachedBranchKey && key !== autoTriedKey;
}

/**
 * Clamp a configured sync interval (seconds) to a usable poll period: a
 * non-finite or non-positive value disables polling (returns 0).
 */
export function normalizeSyncInterval(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}
