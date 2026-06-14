import * as vscode from 'vscode';
import { AuthProvider } from './infra/ado/authProvider';
import { ReviewService } from './app/reviewService';
import { ChangedFilesTreeProvider } from './ui/changedFilesTreeProvider';
import { DiffContentProvider, DIFF_SCHEME, sideUri, headUri } from './ui/diffContentProvider';
import { CommentsController } from './ui/commentsController';
import { NavigationCursor } from './ui/navigationCursor';
import { ViewedStore } from './infra/state/viewedStore';
import { AnchorStore } from './infra/state/anchorStore';
import { getCurrentBranch, repoRoot } from './infra/git/repo';
import { getAutoAttachBranchPr } from './infra/config';
import { ChangedFile, PullRequestSummary } from './domain/models';
import { PrVote } from './domain/types';
import { createLogger } from './common/logger';

export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger();
  const auth = new AuthProvider(context.secrets);
  const reviewService = new ReviewService(auth);
  const viewedStore = new ViewedStore(context.workspaceState);
  const anchorStore = new AnchorStore(context.workspaceState);

  const changedFiles = new ChangedFilesTreeProvider();
  const diffProvider = new DiffContentProvider();
  const comments = new CommentsController(reviewService, anchorStore);
  const cursor = new NavigationCursor();
  const changedFilesView = vscode.window.createTreeView('reviewlens.changedFiles', {
    treeDataProvider: changedFiles,
  });

  /** Tear down all review UI — used when the open PR is completed/abandoned. */
  function closeReview(): void {
    reviewService.setLocalPath(undefined);
    attachedBranchKey = undefined;
    diffProvider.clear();
    comments.clearAll();
    changedFiles.setFiles([], new Set());
    changedFilesView.description = undefined;
    cursor.setFiles([]);
    void vscode.commands.executeCommand('setContext', 'reviewlens.reviewActive', false);
  }

  // Live "branch attach" review: the open workspace is the PR's branch, so its
  // working-tree files are the head side and PR comments render inline on them
  // (no worktree checkout). `attachedBranchKey` is `${repoRoot}#${branch}`, so a
  // branch switch is detected and re-attached.
  let attachedBranchKey: string | undefined;
  // Branch key the auto path last *tried* (attached or not), so a branch with no
  // PR isn't re-queried on every editor switch. Reset on branch change.
  let autoTriedKey: string | undefined;

  /** Locate the workspace git repo that matches the configured ADO repo + its branch. */
  async function resolveOpenBranchRepo(): Promise<
    { repoRoot: string; branch: string } | undefined
  > {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      // Resolve the git toplevel, not the workspace folder, so it matches the
      // repo-relative paths of changed files even when a subfolder is open;
      // otherwise the head file can't be found on disk and comments don't anchor.
      const root = await repoRoot(f.uri.fsPath);
      const branch = root ? await getCurrentBranch(root) : undefined;
      if (root && branch) {
        return { repoRoot: root, branch };
      }
    }
    return undefined;
  }

  /**
   * Find the active PR for the open branch and show its comments inline on the
   * working-tree files. `silent` suppresses "no PR" / error popups so the
   * automatic path stays quiet.
   */
  async function attachToBranchPr(silent: boolean): Promise<void> {
    const open = await resolveOpenBranchRepo();
    if (!open) {
      if (!silent) {
        vscode.window.showWarningMessage('ReviewLens: open a git repository folder first.');
      }
      return;
    }
    const key = `${open.repoRoot}#${open.branch}`;
    let pr: PullRequestSummary | undefined;
    try {
      pr = await reviewService.findByBranch(open.branch);
    } catch (e) {
      if (!silent) {
        vscode.window.showErrorMessage(
          `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
        );
      }
      return;
    }
    if (!pr) {
      if (!silent) {
        vscode.window.showInformationMessage(
          `ReviewLens: no active pull request for branch "${open.branch}".`
        );
      }
      return;
    }
    try {
      diffProvider.clear();
      comments.clearAll();
      const data = await vscode.window.withProgress(
        { location: { viewId: 'reviewlens.changedFiles' } },
        () => reviewService.open(pr!)
      );
      // The open working tree is the head side: point review at it so comments
      // render on the real files and commenting targets them.
      reviewService.setLocalPath(open.repoRoot);
      changedFiles.setFiles(data.files, viewedStore.get(pr.id));
      changedFilesView.description = `#${pr.id} ${pr.title}`;
      cursor.setFiles(data.files);
      attachedBranchKey = key;
      void vscode.commands.executeCommand('setContext', 'reviewlens.reviewActive', true);
      // Render comments on the file already open, if it's one of the PR's files.
      await renderActiveEditor();
      if (!silent) {
        vscode.window.showInformationMessage(
          `ReviewLens: showing comments for PR #${pr.id} on branch "${open.branch}".`
        );
      }
    } catch (e) {
      if (!silent) {
        vscode.window.showErrorMessage(
          `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  /** Auto-attach when enabled and the open branch changed since the last attempt. */
  async function maybeAutoAttach(): Promise<void> {
    if (!getAutoAttachBranchPr()) {
      return;
    }
    const open = await resolveOpenBranchRepo();
    if (!open) {
      return;
    }
    const key = `${open.repoRoot}#${open.branch}`;
    // Already attached to this branch, or already tried it and found no PR:
    // don't re-query ADO on every editor switch. A branch switch changes `key`.
    if (key === attachedBranchKey || key === autoTriedKey) {
      return;
    }
    autoTriedKey = key;
    await attachToBranchPr(true);
  }

  /**
   * In live branch-attach mode, render the open PR's comments onto the active
   * editor when it's one of the PR's changed files (a real working-tree file).
   */
  async function renderActiveEditor(): Promise<void> {
    if (!attachedBranchKey) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const filePath = comments.headDocumentPath(editor.document.uri);
    if (filePath) {
      await comments.renderForFile(filePath, editor.document.uri);
    }
  }

  /** True when a base↔head diff for `filePath` is already open in some tab. */
  function diffTabOpen(filePath: string): boolean {
    const wantLeft = sideUri(reviewService.currentPrId ?? 0, 'left', filePath).toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.original.toString() === wantLeft) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * In branch-attach mode, when the user opens a plain working-tree file that the
   * PR changed, replace it with a base↔head diff (head = the real file, so it
   * stays editable and shows comments). Files the PR did not touch are left as-is
   * for free browsing. Skips when the file's diff is already open, so opening the
   * diff doesn't re-trigger itself.
   */
  async function maybeAutoDiff(editor: vscode.TextEditor | undefined): Promise<boolean> {
    if (!attachedBranchKey || !editor) {
      return false;
    }
    const uri = editor.document.uri;
    // Only act on a plain working-tree file (the diff's left side is our virtual
    // scheme, so a diff editor won't match here and we won't recurse).
    if (uri.scheme !== 'file') {
      return false;
    }
    const filePath = comments.headDocumentPath(uri);
    if (!filePath || diffTabOpen(filePath)) {
      return false;
    }
    const file = reviewService.changedFile(filePath);
    if (!file) {
      return false;
    }
    // openFileDiff renders the comments on the head pane itself.
    await vscode.commands.executeCommand('reviewlens.openFileDiff', file);
    return true;
  }

  context.subscriptions.push(
    changedFilesView,
    comments,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),

    vscode.commands.registerCommand('reviewlens.signIn', async () => {
      const pat = await auth.promptAndStore();
      if (pat) {
        vscode.window.showInformationMessage('ReviewLens: PAT saved.');
        await maybeAutoAttach();
      }
    }),

    vscode.commands.registerCommand('reviewlens.signOut', async () => {
      closeReview();
      await auth.clear();
      vscode.window.showInformationMessage('ReviewLens: signed out.');
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

    // Keybinding-friendly viewed toggle: acts on the file the cursor points at.
    vscode.commands.registerCommand('reviewlens.toggleViewedCurrent', async () => {
      const pr = reviewService.current?.pr;
      const file = cursor.current();
      if (!pr || !file) {
        return;
      }
      const nowViewed = await viewedStore.toggle(pr.id, file.path);
      changedFiles.setViewed(file.path, nowViewed);
    }),

    // Open the active PR in the browser. A keybinding passes nothing, so use
    // the PR currently attached to the open branch.
    vscode.commands.registerCommand('reviewlens.openInBrowser', async () => {
      const target = reviewService.current?.pr;
      if (!target?.url) {
        vscode.window.showWarningMessage('ReviewLens: no pull request to open.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(target.url));
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
      // In worktree review the head pane is a throwaway checkout, so editing it
      // would only drift comment anchors / dirty the worktree — keep it
      // read-only. In branch-attach mode the head pane is the user's own working
      // tree, which they are expected to keep editing, so leave it writable.
      if (realHead && !attachedBranchKey) {
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
      } catch (e) {
        vscode.window.showErrorMessage(
          `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }),

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

    vscode.commands.registerCommand('reviewlens.attachToBranchPr', () =>
      attachToBranchPr(false)
    ),

    // Track whether the active editor is a head-side review doc, so the
    // "add comment" key (Ctrl+[) only overrides outdent on those documents.
    // In live branch-attach mode, also pick up a branch switch, auto-open a
    // diff for changed files, and render the PR's comments onto the file.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void vscode.commands.executeCommand(
        'setContext',
        'reviewlens.headEditor',
        editor ? comments.isHeadDocument(editor.document.uri) : false
      );
      void (async () => {
        await maybeAutoAttach();
        // A changed file auto-opens as a diff that also renders its comments; for
        // everything else (unchanged files, or a diff already open) render onto
        // the editor as-is.
        if (!(await maybeAutoDiff(editor))) {
          await renderActiveEditor();
        }
      })();
    }),

    // A folder added/removed (e.g. opening the repo) can change the open branch.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void maybeAutoAttach();
    })
  );

  const active = vscode.window.activeTextEditor;
  void vscode.commands.executeCommand(
    'setContext',
    'reviewlens.headEditor',
    active ? comments.isHeadDocument(active.document.uri) : false
  );
  void maybeAutoAttach();
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
