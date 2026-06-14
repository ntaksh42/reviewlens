import * as vscode from 'vscode';
import { AuthProvider } from './infra/ado/authProvider';
import { PullRequestService } from './app/pullRequestService';
import { ReviewService } from './app/reviewService';
import { PrListTreeProvider } from './ui/prListTreeProvider';
import { ChangedFilesTreeProvider } from './ui/changedFilesTreeProvider';
import { DiffContentProvider, DIFF_SCHEME, sideUri } from './ui/diffContentProvider';
import { ChangedFile, PullRequestSummary } from './domain/models';
import { createLogger } from './common/logger';

export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger();
  const auth = new AuthProvider(context.secrets);
  const prService = new PullRequestService(auth);
  const reviewService = new ReviewService(auth);

  const prList = new PrListTreeProvider(prService);
  const changedFiles = new ChangedFilesTreeProvider();
  const diffProvider = new DiffContentProvider();
  const changedFilesView = vscode.window.createTreeView('reviewlens.changedFiles', {
    treeDataProvider: changedFiles,
  });

  context.subscriptions.push(
    changedFilesView,
    vscode.window.registerTreeDataProvider('reviewlens.prList', prList),
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
        const data = await vscode.window.withProgress(
          { location: { viewId: 'reviewlens.changedFiles' } },
          () => reviewService.open(pr)
        );
        changedFiles.setFiles(data.files);
        changedFilesView.description = `#${pr.id} ${pr.title}`;
      } catch (e) {
        changedFiles.setFiles([]);
        vscode.window.showErrorMessage(
          `ReviewLens: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }),

    vscode.commands.registerCommand('reviewlens.openFileDiff', async (file: ChangedFile) => {
      const current = reviewService.current;
      if (!current) {
        return;
      }
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
    })
  );

  void prList.refresh();
  log.info('ReviewLens activated.');
}

export function deactivate(): void {}
