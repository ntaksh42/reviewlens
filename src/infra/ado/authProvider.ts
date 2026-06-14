import * as vscode from 'vscode';

const SECRET_KEY = 'reviewlens.pat';

/** PAT-based auth (SPEC D6). Token lives only in SecretStorage. */
export class AuthProvider {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Returns the stored PAT without prompting, or undefined. */
  getPat(): Thenable<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  /** Prompts for a PAT and stores it. Returns the new PAT, or undefined if cancelled. */
  async promptAndStore(): Promise<string | undefined> {
    const pat = await vscode.window.showInputBox({
      title: 'ReviewLens: Azure DevOps PAT',
      prompt: 'Personal Access Token (scope: Code — Read & Write)',
      password: true,
      ignoreFocusOut: true,
    });
    if (!pat) {
      return undefined;
    }
    const trimmed = pat.trim();
    await this.secrets.store(SECRET_KEY, trimmed);
    return trimmed;
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}
