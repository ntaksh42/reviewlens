import * as vscode from 'vscode';
import { ChangedFile, PullRequestOverview, PullRequestSummary, Reviewer, WorkItemRef } from '../domain/models';
import { FileStatus, ReviewerVote } from '../domain/types';

/** A leaf file in the Changed Files section. */
class FileNode extends vscode.TreeItem {
  constructor(public readonly file: ChangedFile, viewed: boolean) {
    super(basename(file.path), vscode.TreeItemCollapsibleState.None);
    this.description = `${viewed ? '✓ ' : ''}${statusLabel(file.status)}`;
    this.tooltip = file.path;
    this.contextValue = 'changedFile';
    this.iconPath = viewed ? new vscode.ThemeIcon('check') : statusIcon(file.status);
    this.resourceUri = vscode.Uri.file(file.path);
    this.command = {
      command: 'reviewlens.openFileDiff',
      title: 'Open diff',
      arguments: [file],
    };
  }
}

/** A folder grouping in the Changed Files tree (compact: may span several path segments). */
class FolderNode extends vscode.TreeItem {
  constructor(
    label: string,
    /** Full path of this folder relative to the root, used to look up children. */
    public readonly folderPath: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = vscode.ThemeIcon.Folder;
    this.resourceUri = vscode.Uri.file(folderPath);
  }
}

/** A node in the in-memory file tree built from changed file paths. */
interface TreeNode {
  /** Child folders keyed by their immediate segment name. */
  folders: Map<string, TreeNode>;
  /** Files living directly in this folder. */
  files: ChangedFile[];
}

class HintNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

/** Top-level collapsible section ("Pull Request" / "Changed Files"). */
class SectionNode extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly section: 'overview' | 'files',
    icon: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `section.${section}`;
  }
}

/** A plain label/value row in the overview (title, author, branches). */
class InfoNode extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip ?? value;
  }
}

/** The "Reviewers" / "Work Items" groups under the overview section. */
class GroupNode extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly group: 'reviewers' | 'workItems',
    count: number,
    icon: string
  ) {
    super(
      label,
      count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class ReviewerNode extends vscode.TreeItem {
  constructor(reviewer: Reviewer) {
    super(reviewer.displayName, vscode.TreeItemCollapsibleState.None);
    this.description = voteLabel(reviewer.vote) + (reviewer.isRequired ? ' · required' : '');
    this.iconPath = voteIcon(reviewer.vote);
  }
}

class WorkItemNode extends vscode.TreeItem {
  constructor(item: WorkItemRef) {
    super(`#${item.id}`, vscode.TreeItemCollapsibleState.None);
    this.description = item.title;
    this.tooltip = item.title;
    this.iconPath = new vscode.ThemeIcon('issues');
    if (item.url) {
      this.command = {
        command: 'vscode.open',
        title: 'Open work item',
        arguments: [vscode.Uri.parse(item.url)],
      };
    }
  }
}

export class ChangedFilesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: ChangedFile[] = [];
  private viewed = new Set<string>();
  private pr: PullRequestSummary | undefined;
  private overview: PullRequestOverview | undefined;

  setFiles(files: ChangedFile[], viewed: Set<string>): void {
    this.files = files;
    this.viewed = viewed;
    this._onDidChangeTreeData.fire();
  }

  /** Supply the open PR's summary + overview so the overview section renders. */
  setOverview(pr: PullRequestSummary | undefined, overview: PullRequestOverview | undefined): void {
    this.pr = pr;
    this.overview = overview;
    this._onDidChangeTreeData.fire();
  }

  setViewed(path: string, isViewed: boolean): void {
    if (isViewed) {
      this.viewed.add(path);
    } else {
      this.viewed.delete(path);
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: vscode.TreeItem): vscode.TreeItem {
    return node;
  }

  getChildren(node?: vscode.TreeItem): vscode.TreeItem[] {
    if (!node) {
      return this.rootSections();
    }
    if (node instanceof SectionNode) {
      return node.section === 'overview' ? this.overviewChildren() : this.fileNodes();
    }
    if (node instanceof GroupNode) {
      return node.group === 'reviewers' ? this.reviewerNodes() : this.workItemNodes();
    }
    if (node instanceof FolderNode) {
      return this.folderChildren(node.folderPath);
    }
    return [];
  }

  private rootSections(): vscode.TreeItem[] {
    if (!this.pr) {
      return [new HintNode('Open a pull request to see changed files.')];
    }
    return [
      new SectionNode('Pull Request', 'overview', 'git-pull-request'),
      new SectionNode('Changed Files', 'files', 'files'),
    ];
  }

  private overviewChildren(): vscode.TreeItem[] {
    const pr = this.pr;
    if (!pr) {
      return [];
    }
    const nodes: vscode.TreeItem[] = [
      new InfoNode(`#${pr.id}`, pr.title, 'git-pull-request', pr.title),
      new InfoNode('Author', pr.author, 'account'),
      new InfoNode('Branch', `${pr.sourceBranch} → ${pr.targetBranch}`, 'git-branch'),
    ];
    const description = this.overview?.description.trim();
    if (description) {
      const node = new InfoNode('Description', oneLine(description), 'note', description);
      nodes.push(node);
    }
    nodes.push(
      new GroupNode('Reviewers', 'reviewers', this.overview?.reviewers.length ?? 0, 'organization'),
      new GroupNode('Work Items', 'workItems', this.overview?.workItems.length ?? 0, 'issues')
    );
    return nodes;
  }

  private reviewerNodes(): vscode.TreeItem[] {
    return (this.overview?.reviewers ?? []).map((r) => new ReviewerNode(r));
  }

  private workItemNodes(): vscode.TreeItem[] {
    return (this.overview?.workItems ?? []).map((w) => new WorkItemNode(w));
  }

  private fileNodes(): vscode.TreeItem[] {
    if (this.files.length === 0) {
      return [new HintNode('No changed files.')];
    }
    return this.folderChildren('');
  }

  /**
   * Build the file tree on demand and return the rows for the folder at `folderPath`
   * (empty string = the Changed Files root). Folders sort before files; each list is
   * alphabetical. Single-child folder chains are compacted into one row, Azure-style.
   */
  private folderChildren(folderPath: string): vscode.TreeItem[] {
    const node = findNode(this.buildTree(), folderPath);
    if (!node) {
      return [];
    }
    const folders = [...node.folders.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, child]) => {
        // Compact: collapse a chain of single-child folders into one row.
        let label = name;
        let path = join(folderPath, name);
        let cur = child;
        while (cur.files.length === 0 && cur.folders.size === 1) {
          const [nextName, nextChild] = [...cur.folders.entries()][0];
          label = `${label}/${nextName}`;
          path = join(path, nextName);
          cur = nextChild;
        }
        return new FolderNode(label, path);
      });
    const files = [...node.files]
      .sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
      .map((f) => new FileNode(f, this.viewed.has(f.path)));
    return [...folders, ...files];
  }

  private buildTree(): TreeNode {
    const root: TreeNode = { folders: new Map(), files: [] };
    for (const file of this.files) {
      const segments = file.path.split('/');
      const fileName = segments.pop()!;
      let cur = root;
      for (const seg of segments) {
        let next = cur.folders.get(seg);
        if (!next) {
          next = { folders: new Map(), files: [] };
          cur.folders.set(seg, next);
        }
        cur = next;
      }
      cur.files.push(file);
    }
    return root;
  }
}

/** Walk the tree to the node at `path` ('' = root). Returns undefined if not found. */
function findNode(root: TreeNode, path: string): TreeNode | undefined {
  if (path === '') {
    return root;
  }
  let cur: TreeNode | undefined = root;
  for (const seg of path.split('/')) {
    cur = cur?.folders.get(seg);
  }
  return cur;
}

function join(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
}

function statusLabel(s: FileStatus): string {
  return { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[s];
}

function statusIcon(s: FileStatus): vscode.ThemeIcon {
  const id = {
    added: 'diff-added',
    modified: 'diff-modified',
    deleted: 'diff-removed',
    renamed: 'diff-renamed',
  }[s];
  return new vscode.ThemeIcon(id);
}

function voteLabel(v: ReviewerVote): string {
  switch (v) {
    case 'approved':
      return 'approved';
    case 'approvedWithSuggestions':
      return 'approved with suggestions';
    case 'waiting':
      return 'waiting for author';
    case 'rejected':
      return 'rejected';
    case 'none':
      return 'no vote';
  }
}

function voteIcon(v: ReviewerVote): vscode.ThemeIcon {
  switch (v) {
    case 'approved':
    case 'approvedWithSuggestions':
      return new vscode.ThemeIcon('thumbsup', new vscode.ThemeColor('charts.green'));
    case 'rejected':
      return new vscode.ThemeIcon('thumbsdown', new vscode.ThemeColor('charts.red'));
    case 'waiting':
      return new vscode.ThemeIcon('comment', new vscode.ThemeColor('charts.yellow'));
    case 'none':
      return new vscode.ThemeIcon('account');
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
