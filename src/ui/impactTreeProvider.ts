import * as vscode from 'vscode';
import { ImpactCaller, ImpactSymbol } from '../infra/lsp/impactAnalyzer';

class SymbolNode extends vscode.TreeItem {
  constructor(public readonly symbol: ImpactSymbol) {
    super(symbol.name, vscode.TreeItemCollapsibleState.Expanded);
    const unchanged = symbol.callers.filter((c) => !c.changed).length;
    this.description = `${symbol.callers.length} callers · ${unchanged} unchanged`;
    this.iconPath = new vscode.ThemeIcon('symbol-method');
    this.tooltip = `${basename(symbol.filePath)}:${symbol.line + 1}`;
  }
}

class CallerNode extends vscode.TreeItem {
  constructor(public readonly caller: ImpactCaller) {
    super(caller.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${basename(caller.filePath)}:${caller.line + 1}`;
    this.iconPath = new vscode.ThemeIcon(caller.changed ? 'check' : 'warning');
    this.tooltip = caller.changed
      ? 'Caller updated in this PR'
      : 'Caller NOT changed in this PR — potential blast radius';
    this.command = {
      command: 'reviewlens.openImpactLocation',
      title: 'Open',
      arguments: [caller.filePath, caller.line],
    };
  }
}

class HintNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

type Node = SymbolNode | CallerNode | HintNode;

export class ImpactTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: ImpactSymbol[] = [];
  private message: string | undefined = 'Run impact analysis on the open repository.';

  setResults(roots: ImpactSymbol[]): void {
    this.roots = roots;
    this.message = roots.length === 0 ? 'No impacted callers found.' : undefined;
    this._onDidChangeTreeData.fire();
  }

  setMessage(message: string): void {
    this.roots = [];
    this.message = message;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.message ? [new HintNode(this.message)] : this.roots.map((s) => new SymbolNode(s));
    }
    if (node instanceof SymbolNode) {
      return node.symbol.callers.map((c) => new CallerNode(c));
    }
    return [];
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
