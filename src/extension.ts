import * as vscode from 'vscode';
import { AuthProvider } from './infra/ado/authProvider';
import { PullRequestService } from './app/pullRequestService';
import { ReviewService } from './app/reviewService';
import { PrListTreeProvider } from './ui/prListTreeProvider';
import { ChangedFilesTreeProvider } from './ui/changedFilesTreeProvider';
import { DiffContentProvider, DIFF_SCHEME, sideUri } from './ui/diffContentProvider';
import { CommentsController } from './ui/commentsController';
import { ImpactTreeProvider } from './ui/impactTreeProvider';
import { NavigationCursor } from './ui/navigationCursor';
import { ViewedStore } from './infra/state/viewedStore';
import { analyzeImpact } from './infra/lsp/impactAnalyzer';
import { ChangedFile, PullRequestSummary } from './domain/models';
import { createLogger } from './common/logger';

export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger();
  const auth = new AuthProvider(context.secrets);
  const prService = new PullRequestService(auth);
  const reviewService = new ReviewService(auth);
  const viewedStore = new ViewedStore(context.workspaceState);

  const prList = new PrListTreeProvider(prService);
  const changedFiles = new ChangedFilesTreeProvider();
  const diffProvider = new DiffContentProvider();
  const comments = new CommentsController(reviewService);
  const impact = new ImpactTreeProvider();
  const cursor = new NavigationCursor();
  const changedFilesView = vscode.window.createTreeView('reviewlens.changedFiles', {
    treeDataProvider: changedFiles,
  });

  context.subscriptions.push(
    changedFilesView,
    comments,
    vscode.window.registerTreeDataProvider('reviewlens.prList', prList),
    vscode.window.registerTreeDataProvider('reviewlens.impact', impact),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),

    vscode.commands.registerCommand('reviewlens.refreshPrs', () => prList.refresh()),

    vscode.commands.registerCommand('reviewlens.signIn', async () => {
      const pat = await auth.promptAndStore();
      if (pat) {
        vscode.window.showInformationMessage('ReviewLens: PAT saved.');
        await prList.refresh();
      }
    }),

    vscode.commands.registerCommand('reviewlens.signOut', async () => {
      await auth.clear();
      vscode.window.showInformationMessage('ReviewLens: signed out.');
      await prList.refresh();
    }),

    vscode.commands.registerCommand('reviewlens.openPr', async (pr: PullRequestSummary) => {
      try {
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

    vscode.commands.registerCommand('reviewlens.openFileDiff', async (file: ChangedFile) => {
      const current = reviewService.current;
      if (!current) {
        return;
      }
      cursor.setCurrent(file);
      const prId = current.pr.id;
      const left = sideUri(prId, 'left', file.path);
      const right = sideUri(prId, 'right', file.path);
      const [base, head] = await Promise.all([
        reviewService.fileContent('left', file),
        reviewService.fileContent('right', file),
      ]);
      diffProvider.set(left, base);
      diffProvider.set(right, head);
      const name = file.path.split('/').pop();
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${name} (base ↔ head) — PR #${prId}`
      );
      comments.renderForFile(file.path, right);
    }),

    vscode.commands.registerCommand('reviewlens.createOrReply', (reply: vscode.CommentReply) =>
      comments.createOrReply(reply)
    ),

    vscode.commands.registerCommand('reviewlens.resolveThread', (thread: vscode.CommentThread) =>
      comments.resolve(thread)
    ),

    vscode.commands.registerCommand('reviewlens.analyzeImpact', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        impact.setMessage('Open the repository folder to analyze impact.');
        return;
      }
      const baseRef = vscode.workspace
        .getConfiguration('reviewlens')
        .get<string>('baseRef', 'main');
      await vscode.window.withProgress(
        { location: { viewId: 'reviewlens.impact' } },
        async () => {
          try {
            const roots = await analyzeImpact(folder.uri.fsPath, baseRef);
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
    )
  );

  void prList.refresh();
  log.info('ReviewLens activated.');
}

export function deactivate(): void {}
