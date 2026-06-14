import * as vscode from 'vscode';
import { ChangedFile } from '../domain/models';
import { FileStatus } from '../domain/types';

class FileNode extends vscode.TreeItem {
  constructor(public readonly file: ChangedFile) {
    super(basename(file.path), vscode.TreeItemCollapsibleState.None);
    this.description = `${statusLabel(file.status)} · ${dirname(file.path)}`;
    this.tooltip = file.path;
    this.iconPath = statusIcon(file.status);
    this.command = {
      command: 'reviewlens.openFileDiff',
      title: 'Open diff',
      arguments: [file],
    };
  }
}

class HintNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

export class ChangedFilesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: ChangedFile[] = [];

  setFiles(files: ChangedFile[]): void {
    this.files = files;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: vscode.TreeItem): vscode.TreeItem {
    return node;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.files.length === 0) {
      return [new HintNode('Open a pull request to see changed files.')];
    }
    return this.files.map((f) => new FileNode(f));
  }
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

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}
