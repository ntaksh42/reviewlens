import * as vscode from 'vscode';

export interface AdoConfig {
  orgUrl: string;
  project: string;
  /** Empty = all repositories in the project. */
  repository: string;
}

export function getAdoConfig(): AdoConfig {
  const c = vscode.workspace.getConfiguration('reviewlens');
  return {
    orgUrl: (c.get<string>('orgUrl') ?? '').trim().replace(/\/+$/, ''),
    project: (c.get<string>('project') ?? '').trim(),
    repository: (c.get<string>('repository') ?? '').trim(),
  };
}

export function isConfigured(config: AdoConfig): boolean {
  return Boolean(config.orgUrl && config.project);
}

/** Optional explicit path to a local clone, used for local (worktree) review. */
export function getLocalRepoPath(): string | undefined {
  const p = (vscode.workspace.getConfiguration('reviewlens').get<string>('localRepoPath') ?? '').trim();
  return p || undefined;
}

/** How many cached local-review worktrees to keep before pruning the oldest. */
export function getLocalWorktreeLimit(): number {
  const n = vscode.workspace.getConfiguration('reviewlens').get<number>('localWorktreeLimit', 5);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
}

/**
 * Use a blobless partial clone (--filter=blob:none) when auto-cloning for local
 * review. Keeps large repos light: file contents are fetched on demand. Disable
 * for fully-offline grep over the whole repo at the cost of a heavier clone.
 */
export function getLocalClonePartial(): boolean {
  return vscode.workspace.getConfiguration('reviewlens').get<boolean>('localClonePartial', true);
}

/**
 * Automatically find the active PR for the open workspace branch and show its
 * comments inline on the working-tree files. Disable to attach only on demand.
 */
export function getAutoAttachBranchPr(): boolean {
  return vscode.workspace.getConfiguration('reviewlens').get<boolean>('autoAttachBranchPr', true);
}
