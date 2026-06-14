import * as vscode from 'vscode';
import { PullRequestService } from '../app/pullRequestService';
import { PullRequestSummary } from '../domain/models';

class PrNode extends vscode.TreeItem {}

export class PrListTreeProvider implements vscode.TreeDataProvider<PrNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private items: PullRequestSummary[] = [];
  private message: string | undefined;

  constructor(private readonly service: PullRequestService) {}

  async refresh(): Promise<void> {
    this.message = undefined;
    try {
      this.items = await this.service.listActive();
      if (this.items.length === 0) {
        this.message = 'No active pull requests.';
      }
    } catch (e) {
      this.items = [];
      this.message = e instanceof Error ? e.message : String(e);
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: PrNode): vscode.TreeItem {
    return node;
  }

  getChildren(): PrNode[] {
    if (this.message) {
      const node = new PrNode(this.message, vscode.TreeItemCollapsibleState.None);
      node.iconPath = new vscode.ThemeIcon('info');
      return [node];
    }
    return this.items.map((pr) => {
      const node = new PrNode(`#${pr.id} ${pr.title}`, vscode.TreeItemCollapsibleState.None);
      node.description = `${pr.author} · ${pr.repository} · ${pr.sourceBranch} → ${pr.targetBranch}`;
      node.tooltip = pr.url || undefined;
      node.iconPath = new vscode.ThemeIcon('git-pull-request');
      node.command = {
        command: 'reviewlens.openPr',
        title: 'Open pull request',
        arguments: [pr],
      };
      return node;
    });
  }
}
