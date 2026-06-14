import * as vscode from 'vscode';
import { ReviewService } from '../app/reviewService';
import { Comment as DomainComment } from '../domain/models';
import { DIFF_SCHEME, parseRightUri } from './diffContentProvider';

interface TrackedThread extends vscode.CommentThread {
  adoThreadId?: number;
}

/**
 * Bridges ADO comment threads and VS Code's comment UI. Threads render on the
 * head (right) side of the diff; commenting is allowed on every line so that
 * unchanged context can be annotated too (FR-09).
 */
export class CommentsController {
  private readonly controller: vscode.CommentController;
  private readonly byUri = new Map<string, vscode.CommentThread[]>();

  constructor(private readonly review: ReviewService) {
    this.controller = vscode.comments.createCommentController('reviewlens', 'ReviewLens');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (document.uri.scheme !== DIFF_SCHEME || !document.uri.path.startsWith('/right/')) {
          return [];
        }
        const last = Math.max(0, document.lineCount - 1);
        return [new vscode.Range(0, 0, last, 0)];
      },
    };
  }

  dispose(): void {
    this.controller.dispose();
  }

  /** (Re)render the threads for a file onto its head-side document. */
  renderForFile(filePath: string, rightUri: vscode.Uri): void {
    this.clear(rightUri);
    const created: vscode.CommentThread[] = [];
    for (const t of this.review.threadsForFile(filePath)) {
      const line = Math.max(0, (t.anchor?.start.line ?? 1) - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const vsThread = this.controller.createCommentThread(
        rightUri,
        range,
        t.comments.map(toComment)
      ) as TrackedThread;
      vsThread.label = `ReviewLens · ${t.status}`;
      vsThread.canReply = true;
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      vsThread.contextValue = t.status === 'closed' ? 'resolved' : 'open';
      vsThread.adoThreadId = t.id != null ? Number(t.id) : undefined;
      created.push(vsThread);
    }
    this.byUri.set(rightUri.toString(), created);
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
    if (!editor || !parseRightUri(editor.document.uri)) {
      return;
    }
    await vscode.commands.executeCommand('workbench.action.addComment');
  }

  async createOrReply(reply: vscode.CommentReply): Promise<void> {
    if (!reply?.thread || !reply.text?.trim()) {
      return;
    }
    const thread = reply.thread as TrackedThread;
    const info = parseRightUri(thread.uri);
    if (!info) {
      return;
    }
    try {
      if (thread.adoThreadId) {
        await this.review.reply(thread.adoThreadId, reply.text);
      } else {
        const line = thread.range ? thread.range.start.line + 1 : 1;
        await this.review.createComment(info.filePath, line, reply.text);
        thread.dispose();
      }
      this.renderForFile(info.filePath, thread.uri);
    } catch (e) {
      vscode.window.showErrorMessage(
        `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async resolve(thread: vscode.CommentThread): Promise<void> {
    const t = thread as TrackedThread;
    const info = parseRightUri(thread.uri);
    if (!info || !t.adoThreadId) {
      return;
    }
    try {
      await this.review.resolve(t.adoThreadId);
      this.renderForFile(info.filePath, thread.uri);
    } catch (e) {
      vscode.window.showErrorMessage(
        `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}

function toComment(c: DomainComment): vscode.Comment {
  return {
    body: new vscode.MarkdownString(c.content),
    mode: vscode.CommentMode.Preview,
    author: { name: c.author },
  };
}
