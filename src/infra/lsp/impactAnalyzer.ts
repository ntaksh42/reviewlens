import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const run = promisify(exec);

const CALLABLE = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

export interface ImpactCaller {
  name: string;
  filePath: string;
  line: number;
  /** True if the call site is itself part of the PR's changed lines. */
  changed: boolean;
}

export interface ImpactSymbol {
  name: string;
  filePath: string;
  line: number;
  callers: ImpactCaller[];
}

/**
 * Finds, for each changed function, its callers — flagging callers that are NOT
 * themselves changed (the blast radius a reviewer is most likely to miss).
 * Operates on the open workspace via the active language server (SPEC §15,
 * validated by the spike §19.4). Falls back to no results if LSP is absent.
 */
export async function analyzeImpact(
  workspaceFsPath: string,
  baseRef: string
): Promise<ImpactSymbol[]> {
  const changes = await getChangedRanges(workspaceFsPath, baseRef);
  if (changes.size === 0) {
    return [];
  }

  const roots: ImpactSymbol[] = [];
  for (const [fsPath, lineSet] of changes) {
    const uri = vscode.Uri.file(fsPath);
    let symbols: vscode.DocumentSymbol[] | undefined;
    try {
      await vscode.workspace.openTextDocument(uri);
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );
    } catch {
      continue;
    }

    for (const sym of collectEnclosingSymbols(symbols ?? [], lineSet)) {
      let callers: ImpactCaller[] = [];
      try {
        callers = await findCallers(uri, sym, changes);
      } catch {
        callers = [];
      }
      callers.sort((a, b) => Number(a.changed) - Number(b.changed));
      roots.push({
        name: sym.name,
        filePath: fsPath,
        line: sym.selectionRange.start.line,
        callers,
      });
    }
  }
  return roots;
}

async function findCallers(
  uri: vscode.Uri,
  sym: vscode.DocumentSymbol,
  changes: Map<string, Set<number>>
): Promise<ImpactCaller[]> {
  const callers: ImpactCaller[] = [];
  const items =
    (await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      'vscode.prepareCallHierarchy',
      uri,
      sym.selectionRange.start
    )) ?? [];

  for (const item of items) {
    const incoming =
      (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls',
        item
      )) ?? [];

    for (const call of incoming) {
      const from = call.from;
      const ranges = call.fromRanges?.length ? call.fromRanges : [from.range];
      const site = ranges[0];
      const changedSet = changes.get(from.uri.fsPath);
      const changed = !!changedSet && ranges.some((r) => rangeHasChangedLine(r, changedSet));
      callers.push({
        name: from.name,
        filePath: from.uri.fsPath,
        line: site.start.line,
        changed,
      });
    }
  }
  return callers;
}

/** Outermost named callable that contains a changed line (spike §19.4 learning). */
function collectEnclosingSymbols(
  symbols: vscode.DocumentSymbol[],
  lineSet: Set<number>,
  acc: vscode.DocumentSymbol[] = []
): vscode.DocumentSymbol[] {
  for (const s of symbols) {
    if (!rangeHasChangedLine(s.range, lineSet)) {
      continue;
    }
    if (CALLABLE.has(s.kind)) {
      acc.push(s);
    } else {
      collectEnclosingSymbols(s.children ?? [], lineSet, acc);
    }
  }
  return acc;
}

function rangeHasChangedLine(range: vscode.Range, lineSet: Set<number>): boolean {
  for (let l = range.start.line; l <= range.end.line; l++) {
    if (lineSet.has(l)) {
      return true;
    }
  }
  return false;
}

async function getChangedRanges(
  cwd: string,
  baseRef: string
): Promise<Map<string, Set<number>>> {
  const candidates = [
    `git diff --unified=0 ${baseRef}...HEAD`,
    `git diff --unified=0 HEAD`,
    `git diff --unified=0`,
  ];
  let stdout = '';
  for (const cmd of candidates) {
    try {
      const res = await run(cmd, { cwd, maxBuffer: 20 * 1024 * 1024 });
      if (res.stdout.trim()) {
        stdout = res.stdout;
        break;
      }
    } catch {
      // try next
    }
  }
  return parseDiff(stdout, cwd);
}

function parseDiff(diff: string, cwd: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let cur: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      cur = p === '/dev/null' ? null : path.resolve(cwd, p.replace(/^b\//, ''));
      if (cur && !map.has(cur)) {
        map.set(cur, new Set());
      }
    } else if (line.startsWith('@@') && cur) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = parseInt(m[1], 10);
        const count = m[2] !== undefined ? parseInt(m[2], 10) : 1;
        for (let i = 0; i < count; i++) {
          map.get(cur)!.add(start - 1 + i);
        }
      }
    }
  }
  for (const [k, v] of map) {
    if (v.size === 0) {
      map.delete(k);
    }
  }
  return map;
}
