const assert = require('assert');
const vscode = require('vscode');

const EXT_ID = 'reviewlens.reviewlens';

describe('ReviewLens activation (M0)', () => {
  it('extension is present', () => {
    assert.ok(vscode.extensions.getExtension(EXT_ID), `extension ${EXT_ID} not found`);
  });

  it('activates without error', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  it('registers all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'reviewlens.signIn',
      'reviewlens.signOut',
      'reviewlens.refreshPrs',
      'reviewlens.openPr',
      'reviewlens.openFileDiff',
    ]) {
      assert.ok(commands.includes(id), `missing command: ${id}`);
    }
  });

  it('contributes the PR and Changed Files views', () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    const views = ext.packageJSON.contributes.views.reviewlens;
    const ids = views.map((v) => v.id);
    assert.ok(ids.includes('reviewlens.prList'), 'prList view missing');
    assert.ok(ids.includes('reviewlens.changedFiles'), 'changedFiles view missing');
  });

  it('runs refresh with no configuration without throwing', async () => {
    // Not configured in the test host -> should surface a hint, not throw.
    await vscode.commands.executeCommand('reviewlens.refreshPrs');
  });
});
