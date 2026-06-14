import * as vscode from 'vscode';
import { PullRequestService } from '../app/pullRequestService';
import { PullRequestSummary } from '../domain/models';

type Node = ProjectNode | RepoNode | PrNode | HintNode;

class ProjectNode extends vscode.TreeItem {
  constructor(public readonly project: string, count: number) {
    super(project || '(no project)', vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count} PR${count === 1 ? '' : 's'}`;
    this.contextValue = 'project';
    this.iconPath = new vscode.ThemeIcon('project');
  }
}

class RepoNode extends vscode.TreeItem {
  constructor(
    public readonly project: string,
    public readonly repository: string,
    count: number
  ) {
    super(repository || '(no repository)', vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count} PR${count === 1 ? '' : 's'}`;
    this.contextValue = 'repository';
    this.iconPath = new vscode.ThemeIcon('repo');
  }
}

class PrNode extends vscode.TreeItem {
  constructor(public readonly pr: PullRequestSummary) {
    super(`#${pr.id} ${pr.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${pr.author} · ${pr.sourceBranch} → ${pr.targetBranch}`;
    this.tooltip = pr.url || undefined;
    this.contextValue = 'pullRequest';
    this.iconPath = new vscode.ThemeIcon('git-pull-request');
    this.command = {
      command: 'reviewlens.openPr',
      title: 'Open pull request',
      arguments: [pr],
    };
  }
}

class HintNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

export class PrListTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private items: PullRequestSummary[] = [];
  private message: string | undefined;
  private filter = '';

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

  /** Set a free-text filter (matches title, author, repo, project, branches). */
  setFilter(filter: string): void {
    this.filter = filter.trim().toLowerCase();
    void vscode.commands.executeCommand(
      'setContext',
      'reviewlens.prFilterActive',
      this.filter.length > 0
    );
    this._onDidChangeTreeData.fire();
  }

  get filterText(): string {
    return this.filter;
  }

  private filtered(): PullRequestSummary[] {
    if (!this.filter) {
      return this.items;
    }
    const q = this.filter;
    return this.items.filter((pr) =>
      [
        `#${pr.id}`,
        pr.title,
        pr.author,
        pr.project,
        pr.repository,
        pr.sourceBranch,
        pr.targetBranch,
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  getChildren(node?: Node): Node[] {
    if (this.message) {
      return node ? [] : [new HintNode(this.message)];
    }

    const visible = this.filtered();

    if (!node) {
      if (visible.length === 0) {
        return [new HintNode(`No pull requests match "${this.filter}".`)];
      }
      const projects = [...new Set(visible.map((p) => p.project))].sort(compare);
      return projects.map(
        (project) =>
          new ProjectNode(project, visible.filter((p) => p.project === project).length)
      );
    }

    if (node instanceof ProjectNode) {
      const inProject = visible.filter((p) => p.project === node.project);
      const repos = [...new Set(inProject.map((p) => p.repository))].sort(compare);
      return repos.map(
        (repo) =>
          new RepoNode(node.project, repo, inProject.filter((p) => p.repository === repo).length)
      );
    }

    if (node instanceof RepoNode) {
      return visible
        .filter((p) => p.project === node.project && p.repository === node.repository)
        .sort((a, b) => b.id - a.id)
        .map((pr) => new PrNode(pr));
    }

    return [];
  }
}

function compare(a: string, b: string): number {
  return a.localeCompare(b);
}
