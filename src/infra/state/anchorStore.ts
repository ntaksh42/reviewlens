import * as vscode from 'vscode';

/** A remembered anchor line, so a thread can be relocated if the head drifts. */
export interface AnchorSnapshot {
  filePath: string;
  /** Normalized text of the anchored line at the time the snapshot was taken. */
  text: string;
}

/**
 * Persists per-PR, per-thread anchor snapshots in workspaceState (FR-10). A
 * comment is created against a specific iteration's head; later pushes can shift
 * the anchored line. Remembering the line's text lets the comment be re-anchored
 * to wherever that line moved (see CommentsController.renderForFile).
 */
export class AnchorStore {
  constructor(private readonly state: vscode.Memento) {}

  private key(prId: number): string {
    return `pr:${prId}:anchors`;
  }

  /** Snapshot for a thread, or undefined if none was recorded. */
  get(prId: number, threadId: number): AnchorSnapshot | undefined {
    return this.all(prId)[String(threadId)];
  }

  async set(prId: number, threadId: number, snapshot: AnchorSnapshot): Promise<void> {
    const map = this.all(prId);
    map[String(threadId)] = snapshot;
    await this.state.update(this.key(prId), map);
  }

  /** Forget a PR's anchor snapshots (e.g. once it is completed/abandoned). */
  async clear(prId: number): Promise<void> {
    await this.state.update(this.key(prId), undefined);
  }

  private all(prId: number): Record<string, AnchorSnapshot> {
    return { ...this.state.get<Record<string, AnchorSnapshot>>(this.key(prId), {}) };
  }
}

/** Whitespace-collapsed line text; '' for blank lines (never used as an anchor). */
export function normalizeAnchorText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
