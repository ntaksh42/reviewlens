import * as vscode from 'vscode';

/** Persists per-PR "viewed" file paths in workspaceState (SPEC §12). */
export class ViewedStore {
  constructor(private readonly state: vscode.Memento) {}

  private key(prId: number): string {
    return `pr:${prId}:viewed`;
  }

  get(prId: number): Set<string> {
    return new Set(this.state.get<string[]>(this.key(prId), []));
  }

  async toggle(prId: number, path: string): Promise<boolean> {
    const set = this.get(prId);
    const nowViewed = !set.has(path);
    if (nowViewed) {
      set.add(path);
    } else {
      set.delete(path);
    }
    await this.state.update(this.key(prId), [...set]);
    return nowViewed;
  }

  /**
   * Clear the viewed flag for the given paths (FR-20: on a new iteration, the
   * files that changed again are no longer "viewed"). No-op when none were set.
   */
  async unset(prId: number, paths: Iterable<string>): Promise<void> {
    const set = this.get(prId);
    let removed = false;
    for (const p of paths) {
      removed = set.delete(p) || removed;
    }
    if (removed) {
      await this.state.update(this.key(prId), [...set]);
    }
  }
}
