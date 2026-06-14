const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const util = require('util');
const exec = util.promisify(cp.exec);

const CALLABLE = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

function activate(context) {
  const provider = new ImpactProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('reviewlensImpact', provider),
    vscode.commands.registerCommand('reviewlens.analyzeImpact', () => provider.analyze()),
    vscode.commands.registerCommand('reviewlens.openLocation', openLocation)
  );
}

async function openLocation(uri, range) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

class ImpactProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.roots = [];
  }

  getChildren(node) {
    return node ? node.children || [] : this.roots;
  }

  getTreeItem(node) {
    if (node.kind === 'symbol') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      const unchanged = node.children.filter((c) => !c.changed).length;
      item.description = `${node.children.length} callers · ${unchanged} unchanged`;
      item.iconPath = new vscode.ThemeIcon('symbol-method');
      item.tooltip = node.detail;
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.changed ? 'check' : 'warning');
    item.tooltip = node.changed
      ? 'PR内で変更済みの呼び出し元'
      : '未変更の呼び出し元（波及漏れ候補）';
    item.command = {
      command: 'reviewlens.openLocation',
      title: 'Open',
      arguments: [node.uri, node.range],
    };
    return item;
  }

  async analyze() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) {
      vscode.window.showErrorMessage('ReviewLens: ワークスペースフォルダを開いてください。');
      return;
    }
    const cwd = folder.uri.fsPath;
    const baseRef = vscode.workspace.getConfiguration('reviewlens').get('baseRef', 'main');

    const changes = await getChangedRanges(cwd, baseRef);
    if (changes.size === 0) {
      vscode.window.showInformationMessage('ReviewLens: 変更が見つかりませんでした。');
      this.roots = [];
      this._onDidChange.fire();
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ReviewLens: 影響範囲を解析中…' },
      async () => {
        const roots = [];
        for (const [fsPath, lineSet] of changes) {
          const uri = vscode.Uri.file(fsPath);
          let symbols;
          try {
            await vscode.workspace.openTextDocument(uri);
            symbols = await vscode.commands.executeCommand(
              'vscode.executeDocumentSymbolProvider',
              uri
            );
          } catch (e) {
            continue;
          }
          const enclosing = collectEnclosingSymbols(symbols || [], lineSet);
          for (const sym of enclosing) {
            let callers = [];
            try {
              callers = await findCallers(uri, sym, changes);
            } catch (e) {
              console.error('ReviewLens: findCallers failed for', sym.name, e);
            }
            callers.sort((a, b) => (a.changed ? 1 : 0) - (b.changed ? 1 : 0));
            roots.push({
              kind: 'symbol',
              label: sym.name,
              detail: `${path.basename(fsPath)} · ${sym.detail || ''}`,
              uri,
              range: sym.range,
              children: callers,
            });
          }
        }
        this.roots = roots;
        this._onDidChange.fire();
      }
    );

    vscode.commands.executeCommand('reviewlensImpact.focus');
    if (this.roots.length === 0) {
      vscode.window.showInformationMessage(
        'ReviewLens: 呼び出し元が見つかりませんでした（この言語が Call Hierarchy 非対応の可能性）。'
      );
    }
  }
}

async function findCallers(uri, sym, changes) {
  const callers = [];
  const items =
    (await vscode.commands.executeCommand(
      'vscode.prepareCallHierarchy',
      uri,
      sym.selectionRange.start
    )) || [];
  for (const hitem of items) {
    const incoming =
      (await vscode.commands.executeCommand('vscode.provideIncomingCalls', hitem)) || [];
    for (const call of incoming) {
      const from = call.from;
      const callRanges = call.fromRanges && call.fromRanges.length ? call.fromRanges : [from.range];
      const site = callRanges[0];
      const changedSet = changes.get(from.uri.fsPath);
      const changed = !!(changedSet && callRanges.some((r) => rangeHasChangedLine(r, changedSet)));
      callers.push({
        kind: 'caller',
        label: from.name,
        description: `${path.basename(from.uri.fsPath)}:${site.start.line + 1}`,
        uri: from.uri,
        range: site,
        changed,
      });
    }
  }
  return callers;
}

// Pick the OUTERMOST callable (function/method/constructor) that contains a
// changed line. Do not descend into inner closures: anonymous callbacks have no
// callers and are not the unit other code calls. Descend only through containers
// (class / namespace / module) to reach their methods.
function collectEnclosingSymbols(symbols, lineSet, acc = []) {
  for (const s of symbols) {
    if (!rangeHasChangedLine(s.range, lineSet)) continue;
    if (CALLABLE.has(s.kind)) {
      acc.push(s);
    } else {
      collectEnclosingSymbols(s.children || [], lineSet, acc);
    }
  }
  return acc;
}

function rangeHasChangedLine(range, lineSet) {
  for (let l = range.start.line; l <= range.end.line; l++) {
    if (lineSet.has(l)) return true;
  }
  return false;
}

async function getChangedRanges(cwd, baseRef) {
  const candidates = [
    `git diff --unified=0 ${baseRef}...HEAD`,
    `git diff --unified=0 HEAD`,
    `git diff --unified=0`,
  ];
  let stdout = '';
  for (const cmd of candidates) {
    try {
      const res = await exec(cmd, { cwd, maxBuffer: 20 * 1024 * 1024 });
      if (res.stdout && res.stdout.trim()) {
        stdout = res.stdout;
        break;
      }
    } catch (e) {
      // try next candidate
    }
  }
  return parseDiff(stdout, cwd);
}

function parseDiff(diff, cwd) {
  const map = new Map();
  let curPath = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') {
        curPath = null;
        continue;
      }
      curPath = path.resolve(cwd, p.replace(/^b\//, ''));
      if (!map.has(curPath)) map.set(curPath, new Set());
    } else if (line.startsWith('@@') && curPath) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = parseInt(m[1], 10);
        const count = m[2] !== undefined ? parseInt(m[2], 10) : 1;
        for (let i = 0; i < count; i++) map.get(curPath).add(start - 1 + i);
      }
    }
  }
  for (const [k, v] of map) {
    if (v.size === 0) map.delete(k);
  }
  return map;
}

function deactivate() {}

module.exports = { activate, deactivate };
