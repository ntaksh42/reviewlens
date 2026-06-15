import * as vscode from 'vscode';
import { ReviewService } from '../app/reviewService';
import { CommentTarget } from '../infra/ado/adoClient';
import { AnchorStore, normalizeAnchorText } from '../infra/state/anchorStore';
import { Comment as DomainComment } from '../domain/models';
import { extractSuggestion } from '../domain/suggestion';
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
/** A suggestion being drafted in a scratch editor, awaiting submit. */
interface PendingSuggestion {
  /** Repo-relative path of the head file the suggestion targets. */
  filePath: string;
  /** Head-side document URI the comment will be anchored on. */
  targetUri: vscode.Uri;
  /** Line span (1-based) the suggestion replaces. */
  target: CommentTarget;
  /** URI of the scratch editor holding the draft text. */
  scratchUri: vscode.Uri;
}

export class CommentsController {
  private readonly controller: vscode.CommentController;
  private readonly byUri = new Map<string, vscode.CommentThread[]>();
  /** At most one suggestion is being drafted at a time; submit/cancel clears it. */
  private pendingSuggestion: PendingSuggestion | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly review: ReviewService,
    private readonly anchors: AnchorStore
  ) {
    this.controller = vscode.comments.createCommentController('reviewlens', 'ReviewLens');
    this.controller.options = {
      placeHolder: 'Reply...',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (!this.headPath(document.uri)) {
          return [];
        }
        const last = Math.max(0, document.lineCount - 1);
        return [new vscode.Range(0, 0, last, 0)];
      },
    };
    // Closing the scratch editor without submitting cancels the draft.
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (this.pendingSuggestion && doc.uri.toString() === this.pendingSuggestion.scratchUri.toString()) {
          this.clearPendingSuggestion();
        }
      })
    );
  }

  /** Forget the in-progress suggestion draft and clear its keybinding context. */
  private clearPendingSuggestion(): void {
    this.pendingSuggestion = undefined;
    void vscode.commands.executeCommand('setContext', 'reviewlens.suggestionDraft', false);
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
    this.disposables.forEach((d) => d.dispose());
  }

  /**
   * (Re)render the threads for a file onto its head-side document. Each thread is
   * re-anchored against the current head text using its stored snapshot, so a
   * comment that drifted across PR iterations lands back on its original line
   * (and is flagged when it had to move) instead of the stale stored line.
   */
  async renderForFile(
    filePath: string,
    rightUri: vscode.Uri,
    expandThreadId?: number
  ): Promise<void> {
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
      vsThread.collapsibleState =
        threadId != null && threadId === expandThreadId
          ? vscode.CommentThreadCollapsibleState.Expanded
          : vscode.CommentThreadCollapsibleState.Collapsed;
      // A "suggestion" context value lets the thread title offer "Apply".
      const hasSuggestion = extractSuggestion(t.comments[0]?.content) != null;
      vsThread.contextValue =
        (t.status === 'closed' ? 'resolved' : 'open') + (hasSuggestion ? '.suggestion' : '');
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

  /**
   * Start a suggestion on the active head-side editor's selection. Opens the
   * selected lines in a scratch editor (same language, so syntax highlighting and
   * multi-line editing work naturally), which the user edits and then submits
   * with `reviewlens.submitSuggestion`. The draft is wrapped in a ```suggestion
   * block and posted as a thread anchored to the selected span (FR-29).
   */
  async addSuggestionAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const filePath = this.headPath(editor.document.uri);
    if (!filePath) {
      return;
    }
    const sel = editor.selection;
    const startLine = sel.start.line;
    // An empty selection suggests a replacement for just the cursor's line.
    const endLine = sel.isEmpty || sel.end.character > 0 ? sel.end.line : sel.end.line - 1;
    const lastEnd = editor.document.lineAt(endLine).text.length;
    const range = new vscode.Range(startLine, 0, endLine, lastEnd);
    const original = editor.document.getText(range);

    // Open a scratch document seeded with the selected text, in the same
    // language, so the user edits a real multi-line buffer instead of an input box.
    const scratch = await vscode.workspace.openTextDocument({
      content: original,
      language: editor.document.languageId,
    });
    this.pendingSuggestion = {
      filePath,
      targetUri: editor.document.uri,
      target: {
        startLine: startLine + 1,
        startOffset: 1,
        endLine: endLine + 1,
        endOffset: lastEnd + 1,
      },
      scratchUri: scratch.uri,
    };
    await vscode.window.showTextDocument(scratch, { preview: false });
    void vscode.commands.executeCommand('setContext', 'reviewlens.suggestionDraft', true);
    vscode.window.showInformationMessage(
      'ReviewLens: edit the suggested replacement, then run "Submit suggestion" (Ctrl+K Ctrl+S).'
    );
  }

  /**
   * Submit the suggestion drafted in the scratch editor: wrap its current text in
   * a ```suggestion block and post it as a thread on the original head file. Run
   * from the scratch editor opened by `addSuggestionAtCursor`.
   */
  async submitSuggestion(): Promise<void> {
    const pending = this.pendingSuggestion;
    const editor = vscode.window.activeTextEditor;
    if (!pending || !editor || editor.document.uri.toString() !== pending.scratchUri.toString()) {
      vscode.window.showWarningMessage(
        'ReviewLens: no suggestion draft is open. Start one with "Suggest a change on selected lines".'
      );
      return;
    }
    const body = '```suggestion\n' + editor.document.getText() + '\n```';
    try {
      const newId = await this.review.createComment(pending.filePath, pending.target, body);
      if (newId != null) {
        await this.snapshotLine(
          pending.targetUri,
          pending.filePath,
          newId,
          pending.target.startLine - 1
        );
      }
      this.clearPendingSuggestion();
      // Close the scratch editor and re-render the target so the new thread shows.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await this.renderForFile(pending.filePath, pending.targetUri);
      vscode.window.showInformationMessage('ReviewLens: suggestion posted.');
    } catch (e) {
      vscode.window.showErrorMessage(
        `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /**
   * Apply a ```suggestion block from a thread's first comment onto the head-side
   * working-tree file, replacing the thread's anchored line range. Only works in
   * branch-attach mode where the head document is the real editable file.
   */
  async applySuggestion(thread: vscode.CommentThread): Promise<void> {
    const t = thread as TrackedThread;
    const filePath = this.headPath(thread.uri);
    if (!filePath || thread.uri.scheme !== 'file') {
      vscode.window.showWarningMessage(
        'ReviewLens: suggestions can only be applied to the working-tree file (branch-attach mode).'
      );
      return;
    }
    const domainThread = this.review.threads.find(
      (d) => d.id != null && t.adoThreadId != null && Number(d.id) === t.adoThreadId
    );
    const suggestion = domainThread && extractSuggestion(domainThread.comments[0]?.content);
    if (suggestion == null) {
      vscode.window.showWarningMessage('ReviewLens: this comment has no suggestion block.');
      return;
    }
    const anchor = domainThread!.anchor;
    if (!anchor) {
      return;
    }
    const doc = await this.tryOpen(thread.uri);
    if (!doc) {
      return;
    }
    const startLine = Math.max(0, anchor.start.line - 1);
    const endLine = Math.min(doc.lineCount - 1, Math.max(startLine, anchor.end.line - 1));
    const range = new vscode.Range(
      startLine,
      0,
      endLine,
      doc.lineAt(endLine).text.length
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(thread.uri, range, suggestion);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      vscode.window.showErrorMessage('ReviewLens: could not apply the suggestion.');
      return;
    }
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage('ReviewLens: suggestion applied.');
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
