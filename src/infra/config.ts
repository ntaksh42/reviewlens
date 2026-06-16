import * as vscode from 'vscode';
import { normalizeSyncInterval } from '../domain/attach';

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

/**
 * Automatically find the active PR for the open workspace branch and show its
 * comments inline on the working-tree files. Disable to attach only on demand.
 */
export function getAutoAttachBranchPr(): boolean {
  return vscode.workspace.getConfiguration('reviewlens').get<boolean>('autoAttachBranchPr', true);
}

/**
 * How often (seconds) to re-fetch the open PR's comment threads from ADO so new
 * comments by others appear without a manual refresh. 0 disables polling.
 */
export function getSyncInterval(): number {
  const raw = vscode.workspace.getConfiguration('reviewlens').get<number>('syncInterval', 30);
  return normalizeSyncInterval(raw);
}
