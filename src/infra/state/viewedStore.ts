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

  /** Forget a PR's viewed state (e.g. once it is completed/abandoned). */
  async clear(prId: number): Promise<void> {
    await this.state.update(this.key(prId), undefined);
  }
}
