import * as vscode from 'vscode';
import { AuthProvider } from './infra/ado/authProvider';
import { PullRequestService } from './app/pullRequestService';
import { ReviewService } from './app/reviewService';
import { PrListTreeProvider } from './ui/prListTreeProvider';
import { ChangedFilesTreeProvider } from './ui/changedFilesTreeProvider';
import { DiffContentProvider, DIFF_SCHEME, sideUri, headUri } from './ui/diffContentProvider';
import { CommentsController } from './ui/commentsController';
import { ImpactTreeProvider } from './ui/impactTreeProvider';
import { NavigationCursor } from './ui/navigationCursor';
import { ViewedStore } from './infra/state/viewedStore';
import { AnchorStore } from './infra/state/anchorStore';
import { analyzeImpact } from './infra/lsp/impactAnalyzer';
import {
  resolveLocalRepo,
  ensureWorktree,
  pruneWorktrees,
  Worktree,
} from './infra/git/worktree';
import { getLocalRepoPath, getLocalWorktreeLimit } from './infra/config';
import { ChangedFile, PullRequestSummary } from './domain/models';
import { PrVote } from './domain/types';
import { createLogger } from './common/logger';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger();
  const auth = new AuthProvider(context.secrets);
  const prService = new PullRequestService(auth);
  const reviewService = new ReviewService(auth);
  const viewedStore = new ViewedStore(context.workspaceState);
  const anchorStore = new AnchorStore(context.workspaceState);

  const prList = new PrListTreeProvider(prService);
  const changedFiles = new ChangedFilesTreeProvider();
  const diffProvider = new DiffContentProvider();
  const comments = new CommentsController(reviewService, anchorStore);
  const impact = new ImpactTreeProvider();
  const cursor = new NavigationCursor();
  const changedFilesView = vscode.window.createTreeView('reviewlens.changedFiles', {
    treeDataProvider: changedFiles,
  });

  // Local (worktree) review state. Undefined unless the user opted in for the
  // currently open PR.
  let activeWorktree: Worktree | undefined;

  const cacheRoot = (): string =>
    path.join(context.globalStorageUri.fsPath, 'worktrees');

  function teardownLocal(): void {
    const wt = activeWorktree;
    activeWorktree = undefined;
    reviewService.setLocalPath(undefined);
    void vscode.commands.executeCommand('setContext', 'reviewlens.localActive', false);
    if (!wt) {
      return;
    }
    // Drop the worktree folder from the workspace (never index 0, so no reload).
    // The worktree itself is left on disk for reuse; pruneWorktrees bounds growth.
    const folders = vscode.workspace.workspaceFolders ?? [];
    const idx = folders.findIndex((f) => f.uri.fsPath === wt.worktreePath);
    if (idx > 0) {
      vscode.workspace.updateWorkspaceFolders(idx, 1);
    }
  }

  /** Tear down all review UI — used after a PR leaves the active list. */
  function closeReview(): void {
    teardownLocal();
    diffProvider.clear();
    comments.clearAll();
    changedFiles.setFiles([], new Set());
    changedFilesView.description = undefined;
    cursor.setFiles([]);
    void vscode.commands.executeCommand('setContext', 'reviewlens.reviewActive', false);
  }

  context.subscriptions.push(
    changedFilesView,
    comments,
    vscode.window.registerTreeDataProvider('reviewlens.prList', prList),
    vscode.window.registerTreeDataProvider('reviewlens.impact', impact),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),

    vscode.commands.registerCommand('reviewlens.refreshPrs', () => prList.refresh()),

    vscode.commands.registerCommand('reviewlens.filterPrs', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Filter pull requests (title, author, repository, project, branch)',
        placeHolder: 'e.g. bugfix, alice, my-repo',
        value: prList.filterText,
      });
      if (value !== undefined) {
        prList.setFilter(value);
      }
    }),

    vscode.commands.registerCommand('reviewlens.clearFilter', () => prList.setFilter('')),

    vscode.commands.registerCommand('reviewlens.signIn', async () => {
      const pat = await auth.promptAndStore();
      if (pat) {
        vscode.window.showInformationMessage('ReviewLens: PAT saved.');
        await prList.refresh();
      }
    }),

    vscode.commands.registerCommand('reviewlens.signOut', async () => {
      teardownLocal();
      await auth.clear();
      vscode.window.showInformationMessage('ReviewLens: signed out.');
      await prList.refresh();
    }),

    vscode.commands.registerCommand('reviewlens.openPr', async (pr: PullRequestSummary) => {
      try {
        teardownLocal();
        diffProvider.clear();
        comments.clearAll();
        const data = await vscode.window.withProgress(
          { location: { viewId: 'reviewlens.changedFiles' } },
          () => reviewService.open(pr)
        );
        changedFiles.setFiles(data.files, viewedStore.get(pr.id));
        changedFilesView.description = `#${pr.id} ${pr.title}`;
        cursor.setFiles(data.files);
        void vscode.commands.executeCommand('setContext', 'reviewlens.reviewActive', true);
      } catch (e) {
        changedFiles.setFiles([], new Set());
        vscode.window.showErrorMessage(
          `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }),

    vscode.commands.registerCommand(
      'reviewlens.toggleViewed',
      async (node: { file: ChangedFile }) => {
        const pr = reviewService.current?.pr;
        if (!pr || !node?.file) {
          return;
        }
        const nowViewed = await viewedStore.toggle(pr.id, node.file.path);
        changedFiles.setViewed(node.file.path, nowViewed);
      }
    ),

    vscode.commands.registerCommand('reviewlens.reviewLocally', async () => {
      const current = reviewService.current;
      if (!current) {
        vscode.window.showWarningMessage('ReviewLens: open a pull request first.');
        return;
      }
      const headSha = current.data.headCommit;
      if (!headSha) {
        vscode.window.showErrorMessage('ReviewLens: the PR head commit is unknown.');
        return;
      }
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        vscode.window.showWarningMessage(
          'ReviewLens: open a folder or workspace before starting local review.'
        );
        return;
      }
      try {
        await vscode.window.withProgress(
          { location: { viewId: 'reviewlens.changedFiles' }, title: 'Checking out PR locally…' },
          async () => {
            const candidates = folders.map((f) => f.uri.fsPath);
            const repo = await resolveLocalRepo(
              current.pr.remoteUrl,
              candidates,
              getLocalRepoPath()
            );
            if (!repo) {
              throw new Error(
                'no local clone found — open the repo as a folder or set reviewlens.localRepoPath.'
              );
            }
            const wt = await ensureWorktree(repo, headSha, cacheRoot());
            activeWorktree = wt;
            reviewService.setLocalPath(wt.worktreePath);
            // Bound the cache: drop the least-recently-used worktrees, keeping
            // the one we just materialized.
            await pruneWorktrees(cacheRoot(), getLocalWorktreeLimit(), [wt.worktreePath]);
            // Append the worktree as a workspace folder so the language server
            // indexes the PR's head version (cross-file nav, references, grep).
            const existing = (vscode.workspace.workspaceFolders ?? []).some(
              (f) => f.uri.fsPath === wt.worktreePath
            );
            if (!existing) {
              vscode.workspace.updateWorkspaceFolders(
                vscode.workspace.workspaceFolders?.length ?? 0,
                0,
                { uri: vscode.Uri.file(wt.worktreePath), name: `PR #${current.pr.id} (head)` }
              );
            }
          }
        );
        void vscode.commands.executeCommand('setContext', 'reviewlens.localActive', true);
        vscode.window.showInformationMessage(
          'ReviewLens: local review on. Reopen a file to navigate its neighbors.'
        );
      } catch (e) {
        teardownLocal();
        vscode.window.showErrorMessage(
          `ReviewLens: local review failed — ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }),

    vscode.commands.registerCommand('reviewlens.stopLocalReview', async () => {
      teardownLocal();
      vscode.window.showInformationMessage('ReviewLens: local review off.');
    }),

    vscode.commands.registerCommand('reviewlens.openFileDiff', async (file: ChangedFile) => {
      const current = reviewService.current;
      if (!current) {
        return;
      }
      cursor.setCurrent(file);
      const prId = current.pr.id;
      const left = sideUri(prId, 'left', file.path);
      // In local review the head side is the real worktree file (full code
      // intelligence); otherwise it's a virtual document from the ADO content API.
      const right = headUri(prId, file.path, reviewService.localPath);
      const realHead = right.scheme !== DIFF_SCHEME;
      const [base, head] = await Promise.all([
        reviewService.fileContent('left', file),
        realHead ? Promise.resolve('') : reviewService.fileContent('right', file),
      ]);
      diffProvider.set(left, base);
      if (!realHead) {
        diffProvider.set(right, head);
      }
      const name = file.path.split('/').pop();
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${name} (base ↔ head) — PR #${prId}`
      );
      if (realHead) {
        // The head pane is a real, writable file; editing it would drift comment
        // anchors and dirty the worktree, so mark it read-only for the session.
        // Best-effort: the command is absent on older VS Code.
        try {
          await vscode.commands.executeCommand(
            'workbench.action.files.setActiveEditorReadonlyInSession'
          );
        } catch {
          // ignore
        }
      }
      await comments.renderForFile(file.path, right);
    }),

    vscode.commands.registerCommand('reviewlens.createOrReply', (reply: vscode.CommentReply) =>
      comments.createOrReply(reply)
    ),

    vscode.commands.registerCommand('reviewlens.addComment', () => comments.addCommentAtCursor()),

    vscode.commands.registerCommand('reviewlens.resolveThread', (thread: vscode.CommentThread) =>
      comments.resolve(thread)
    ),

    vscode.commands.registerCommand('reviewlens.castVote', async () => {
      const current = reviewService.current;
      if (!current) {
        vscode.window.showWarningMessage('ReviewLens: open a pull request first.');
        return;
      }
      type Action = { kind: 'vote'; vote: PrVote } | { kind: 'complete' } | { kind: 'abandon' };
      interface VoteItem extends vscode.QuickPickItem {
        action?: Action;
      }
      const items: VoteItem[] = [
        { label: '$(thumbsup) Approve', action: { kind: 'vote', vote: 'approve' } },
        {
          label: '$(thumbsup) Approve with suggestions',
          action: { kind: 'vote', vote: 'approveWithSuggestions' },
        },
        {
          label: '$(comment) Wait for the author',
          action: { kind: 'vote', vote: 'waitForAuthor' },
        },
        { label: '$(thumbsdown) Reject', action: { kind: 'vote', vote: 'reject' } },
        { label: '$(circle-slash) Reset vote', action: { kind: 'vote', vote: 'reset' } },
        { label: 'Pull request', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(git-merge) Complete (merge) pull request…', action: { kind: 'complete' } },
        { label: '$(trash) Abandon pull request…', action: { kind: 'abandon' } },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `PR #${current.pr.id} — ${current.pr.title}`,
        placeHolder: 'Cast your review verdict, or complete / abandon the PR',
      });
      const action = picked?.action;
      if (!action) {
        return;
      }
      try {
        if (action.kind === 'vote') {
          await vscode.window.withProgress(
            { location: { viewId: 'reviewlens.changedFiles' }, title: 'Submitting vote…' },
            () => reviewService.vote(action.vote)
          );
          vscode.window.showInformationMessage(`ReviewLens: ${voteLabel(action.vote)}.`);
          return;
        }
        // Complete and Abandon change the PR's state irreversibly from here, so
        // confirm before round-tripping to ADO.
        const verb = action.kind === 'complete' ? 'Complete' : 'Abandon';
        const detail =
          action.kind === 'complete'
            ? 'Merges the PR into its target branch using your ADO/branch-policy defaults.'
            : 'Abandons the PR. It can be reactivated later in Azure DevOps.';
        const confirm = await vscode.window.showWarningMessage(
          `${verb} PR #${current.pr.id}?`,
          { modal: true, detail },
          verb
        );
        if (confirm !== verb) {
          return;
        }
        await vscode.window.withProgress(
          { location: { viewId: 'reviewlens.changedFiles' }, title: `${verb} pull request…` },
          () => (action.kind === 'complete' ? reviewService.completePr() : reviewService.abandonPr())
        );
        vscode.window.showInformationMessage(
          `ReviewLens: PR #${current.pr.id} ${
            action.kind === 'complete' ? 'completed' : 'abandoned'
          }.`
        );
        closeReview();
        await prList.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(
          `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }),

    vscode.commands.registerCommand('reviewlens.analyzeImpact', async () => {
      // When local review is on, analyze the PR's head worktree against its real
      // base commit; otherwise fall back to the open folder + configured baseRef.
      const local = reviewService.localPath;
      const baseSha = reviewService.current?.data.baseCommit;
      const analysisRoot = local ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!analysisRoot) {
        impact.setMessage('Open the repository folder to analyze impact.');
        return;
      }
      const baseRef =
        local && baseSha
          ? baseSha
          : vscode.workspace.getConfiguration('reviewlens').get<string>('baseRef', 'main');
      await vscode.window.withProgress(
        { location: { viewId: 'reviewlens.impact' } },
        async () => {
          try {
            const roots = await analyzeImpact(analysisRoot, baseRef);
            impact.setResults(roots);
          } catch (e) {
            impact.setMessage(`Impact analysis failed: ${e instanceof Error ? e.message : e}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand(
      'reviewlens.openImpactLocation',
      async (filePath: string, line: number) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    ),

    vscode.commands.registerCommand('reviewlens.nextFile', () => {
      const file = cursor.next();
      if (file) {
        void vscode.commands.executeCommand('reviewlens.openFileDiff', file);
      }
    }),

    vscode.commands.registerCommand('reviewlens.prevFile', () => {
      const file = cursor.prev();
      if (file) {
        void vscode.commands.executeCommand('reviewlens.openFileDiff', file);
      }
    }),

    vscode.commands.registerCommand('reviewlens.nextChange', () =>
      vscode.commands.executeCommand('workbench.action.compareEditor.nextChange')
    ),

    vscode.commands.registerCommand('reviewlens.prevChange', () =>
      vscode.commands.executeCommand('workbench.action.compareEditor.previousChange')
    ),

    // Track whether the active editor is a head-side review doc, so the
    // "add comment" key (Ctrl+[) only overrides outdent on those documents.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void vscode.commands.executeCommand(
        'setContext',
        'reviewlens.headEditor',
        editor ? comments.isHeadDocument(editor.document.uri) : false
      );
    })
  );

  const active = vscode.window.activeTextEditor;
  void vscode.commands.executeCommand(
    'setContext',
    'reviewlens.headEditor',
    active ? comments.isHeadDocument(active.document.uri) : false
  );
  void prList.refresh();
  log.info('ReviewLens activated.');
}

/** Human-readable confirmation shown after a vote is recorded. */
function voteLabel(vote: PrVote): string {
  switch (vote) {
    case 'approve':
      return 'approved';
    case 'approveWithSuggestions':
      return 'approved with suggestions';
    case 'waitForAuthor':
      return 'marked “wait for the author”';
    case 'reject':
      return 'rejected';
    case 'reset':
      return 'vote reset';
  }
}

export function deactivate(): void {}
