import * as vscode from 'vscode';
import { ReviewService } from '../app/reviewService';
import { CommentTarget } from '../infra/ado/adoClient';
import { AnchorStore, normalizeAnchorText } from '../infra/state/anchorStore';
import { Comment as DomainComment } from '../domain/models';
import { headDocPath } from './diffContentProvider';

interface TrackedThread extends vscode.CommentThread {
  adoThreadId?: number;
}

/** Where a thread ended up relative to its stored anchor. */
type Drift = 'none' | 'moved' | 'lost';

/** How far to search for a drifted anchor line, in each direction. */
const REANCHOR_WINDOW = 200;

/**
 * Bridges ADO comment threads and VS Code's comment UI. Threads render on the
 * head (right) side of the diff; commenting is allowed on every line so that
 * unchanged context can be annotated too (FR-09).
 */
export class CommentsController {
  private readonly controller: vscode.CommentController;
  private readonly byUri = new Map<string, vscode.CommentThread[]>();

  constructor(
    private readonly review: ReviewService,
    private readonly anchors: AnchorStore
  ) {
    this.controller = vscode.comments.createCommentController('reviewlens', 'ReviewLens');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (!this.headPath(document.uri)) {
          return [];
        }
        const last = Math.max(0, document.lineCount - 1);
        return [new vscode.Range(0, 0, last, 0)];
      },
    };
  }

  /**
   * Repo-relative path of a head-side document we accept comments on. In local
   * review the head side is a real worktree file; restrict commenting to the PR's
   * changed files so neighboring files opened for context don't get gutters.
   */
  private headPath(uri: vscode.Uri): string | undefined {
    const filePath = headDocPath(uri, this.review.localPath);
    if (!filePath) {
      return undefined;
    }
    if (uri.scheme === 'file' && !this.review.isChangedFile(filePath)) {
      return undefined;
    }
    return filePath;
  }

  /** True when a document is a head-side review doc we accept comments on. */
  isHeadDocument(uri: vscode.Uri): boolean {
    return this.headPath(uri) !== undefined;
  }

  /** Repo-relative path of a head-side review doc, or undefined if not one. */
  headDocumentPath(uri: vscode.Uri): string | undefined {
    return this.headPath(uri);
  }

  dispose(): void {
    this.controller.dispose();
  }

  /**
   * (Re)render the threads for a file onto its head-side document. Each thread is
   * re-anchored against the current head text using its stored snapshot, so a
   * comment that drifted across PR iterations lands back on its original line
   * (and is flagged when it had to move) instead of the stale stored line.
   */
  async renderForFile(filePath: string, rightUri: vscode.Uri): Promise<void> {
    this.clear(rightUri);
    const prId = this.review.currentPrId;
    const doc = await this.tryOpen(rightUri);
    const created: vscode.CommentThread[] = [];
    for (const t of this.review.threadsForFile(filePath)) {
      const threadId = t.id != null ? Number(t.id) : undefined;
      const snapshot =
        prId != null && threadId != null ? this.anchors.get(prId, threadId) : undefined;
      const stored = Math.max(0, (t.anchor?.start.line ?? 1) - 1);
      const { line, drift } = resolveAnchorLine(doc, stored, snapshot?.text);

      const range = new vscode.Range(line, 0, line, 0);
      const vsThread = this.controller.createCommentThread(
        rightUri,
        range,
        t.comments.map(toComment)
      ) as TrackedThread;
      vsThread.label = `ReviewLens · ${t.status}${driftLabel(drift)}`;
      vsThread.canReply = true;
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      vsThread.contextValue = t.status === 'closed' ? 'resolved' : 'open';
      vsThread.adoThreadId = threadId;
      created.push(vsThread);

      // Opportunistically baseline threads we have no snapshot for (e.g. created
      // outside ReviewLens or before this feature), so a future iteration can
      // detect if this line moves.
      if (prId != null && threadId != null && !snapshot && doc) {
        const text = lineTextNorm(doc, line);
        if (text) {
          void this.anchors.set(prId, threadId, { filePath, text });
        }
      }
    }
    this.byUri.set(rightUri.toString(), created);
  }

  private async tryOpen(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      return undefined;
    }
  }

  clear(uri: vscode.Uri): void {
    this.byUri.get(uri.toString())?.forEach((t) => t.dispose());
    this.byUri.delete(uri.toString());
  }

  clearAll(): void {
    for (const list of this.byUri.values()) {
      list.forEach((t) => t.dispose());
    }
    this.byUri.clear();
  }

  /**
   * Opens a fresh comment input on the cursor line of the active head-side diff,
   * so a thread can be started without reaching for the gutter mouse target.
   * Delegates to VS Code's native add-comment action, which both shows the
   * input box and focuses it.
   */
  async addCommentAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.headPath(editor.document.uri)) {
      return;
    }
    await vscode.commands.executeCommand('workbench.action.addComment');
  }

  async createOrReply(reply: vscode.CommentReply): Promise<void> {
    if (!reply?.thread || !reply.text?.trim()) {
      return;
    }
    const thread = reply.thread as TrackedThread;
    const filePath = this.headPath(thread.uri);
    if (!filePath) {
      return;
    }
    try {
      if (thread.adoThreadId) {
        await this.review.reply(thread.adoThreadId, reply.text);
      } else {
        const target = targetFromSelection(thread);
        const newId = await this.review.createComment(filePath, target, reply.text);
        thread.dispose();
        if (newId != null) {
          await this.snapshotLine(thread.uri, filePath, newId, target.startLine - 1);
        }
      }
      await this.renderForFile(filePath, thread.uri);
    } catch (e) {
      vscode.window.showErrorMessage(
        `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async resolve(thread: vscode.CommentThread): Promise<void> {
    const t = thread as TrackedThread;
    const filePath = this.headPath(thread.uri);
    if (!filePath || !t.adoThreadId) {
      return;
    }
    try {
      await this.review.resolve(t.adoThreadId);
      await this.renderForFile(filePath, thread.uri);
    } catch (e) {
      vscode.window.showErrorMessage(
        `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Remember the text of a freshly anchored line so it can be relocated later. */
  private async snapshotLine(
    uri: vscode.Uri,
    filePath: string,
    threadId: number,
    line0: number
  ): Promise<void> {
    const prId = this.review.currentPrId;
    if (prId == null) {
      return;
    }
    const doc = await this.tryOpen(uri);
    const text = doc ? lineTextNorm(doc, line0) : '';
    if (text) {
      await this.anchors.set(prId, threadId, { filePath, text });
    }
  }
}

/**
 * Resolve where a thread should render. Prefers the stored line when its text
 * still matches the snapshot; otherwise searches a window around it for the
 * remembered line ('moved'); failing that, keeps the stored line ('lost').
 */
function resolveAnchorLine(
  doc: vscode.TextDocument | undefined,
  storedLine0: number,
  snapshotText: string | undefined
): { line: number; drift: Drift } {
  if (!doc) {
    return { line: storedLine0, drift: 'none' };
  }
  const last = Math.max(0, doc.lineCount - 1);
  const stored = Math.min(Math.max(0, storedLine0), last);
  if (!snapshotText) {
    return { line: stored, drift: 'none' };
  }
  if (lineTextNorm(doc, stored) === snapshotText) {
    return { line: stored, drift: 'none' };
  }
  // Walk outward from the stored line so the nearest match wins ties.
  for (let delta = 1; delta <= REANCHOR_WINDOW; delta++) {
    for (const candidate of [stored - delta, stored + delta]) {
      if (candidate >= 0 && candidate <= last && lineTextNorm(doc, candidate) === snapshotText) {
        return { line: candidate, drift: 'moved' };
      }
    }
  }
  return { line: stored, drift: 'lost' };
}

function lineTextNorm(doc: vscode.TextDocument, line0: number): string {
  if (line0 < 0 || line0 >= doc.lineCount) {
    return '';
  }
  return normalizeAnchorText(doc.lineAt(line0).text);
}

function driftLabel(drift: Drift): string {
  switch (drift) {
    case 'moved':
      return ' · ↕ re-anchored';
    case 'lost':
      return ' · ⚠ anchor drifted';
    default:
      return '';
  }
}

function toComment(c: DomainComment): vscode.Comment {
  return {
    body: new vscode.MarkdownString(c.content),
    mode: vscode.CommentMode.Preview,
    author: { name: c.author },
  };
}

/**
 * Anchor the comment to the current selection (a keyword span) when one exists
 * on the thread's line; otherwise fall back to the whole line. VS Code columns
 * are 0-based; ADO offsets are 1-based.
 */
function targetFromSelection(thread: vscode.CommentThread): CommentTarget {
  const line = (thread.range ? thread.range.start.line : 0) + 1;
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === thread.uri.toString()
  );
  const sel = editor?.selection;
  if (sel && !sel.isEmpty && thread.range && sel.start.line === thread.range.start.line) {
    return {
      startLine: sel.start.line + 1,
      startOffset: sel.start.character + 1,
      endLine: sel.end.line + 1,
      endOffset: sel.end.character + 1,
    };
  }
  return { startLine: line, startOffset: 1, endLine: line, endOffset: 1 };
}
