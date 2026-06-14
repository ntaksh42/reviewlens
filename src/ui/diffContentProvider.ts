import * as vscode from 'vscode';
import { Side } from '../domain/types';

export const DIFF_SCHEME = 'reviewlens';

/**
 * Serves base/head file contents as read-only virtual documents so the diff
 * editor can render them (SPEC §10.3). Content is pushed in before opening the
 * diff; the URI keeps the original extension for syntax highlighting.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  clear(): void {
    this.contents.clear();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}

/** Distinct URI per side, preserving the file extension for highlighting. */
export function sideUri(prId: number, side: Side, filePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/${side}/${prId}/${filePath}`,
  });
}

/** Parses a head-side diff URI back into its PR id and repo-relative path. */
export function parseRightUri(uri: vscode.Uri): { prId: number; filePath: string } | undefined {
  if (uri.scheme !== DIFF_SCHEME) {
    return undefined;
  }
  const parts = uri.path.split('/'); // ['', 'right', '67', 'src', 'calc.ts']
  if (parts[1] !== 'right' || parts.length < 4) {
    return undefined;
  }
  const prId = Number(parts[2]);
  const filePath = parts.slice(3).join('/');
  if (!prId || !filePath) {
    return undefined;
  }
  return { prId, filePath };
}
