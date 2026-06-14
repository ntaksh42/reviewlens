import * as vscode from 'vscode';

export interface Logger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export function createLogger(): Logger {
  const channel = vscode.window.createOutputChannel('ReviewLens');
  return {
    info: (m) => channel.appendLine(`[info] ${m}`),
    error: (m, e) => channel.appendLine(`[error] ${m}${e ? ` ${String(e)}` : ''}`),
  };
}
