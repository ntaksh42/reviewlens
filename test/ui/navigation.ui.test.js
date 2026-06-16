// ExTester UI walkthrough: drive a real VS Code window against the live PR #68
// and screenshot each navigation step so we can confirm the diff/comment jumps
// actually move the editor. Needs ADO_PAT and a workspace checked out on the
// PR's source branch (set up by scripts/ui-verify.ps1).
//
//   ADO_PAT=<pat> npm run test:ui
//
// Screenshots land in test-resources/screenshots/<timestamp>/.
const path = require('path');
const assert = require('assert');
const { VSBrowser, Workbench, InputBox, EditorView, ActivityBar } = require('vscode-extension-tester');

const PAT = process.env.ADO_PAT;
const WS = process.env.RL_UI_WORKSPACE || path.join(require('os').tmpdir(), 'reviewlens-ui-ws');

async function shot(name) {
  // VSBrowser saves under test-resources/screenshots/<suite>/<name>.png
  await VSBrowser.instance.takeScreenshot(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(PAT ? describe : describe.skip)('ReviewLens UI walkthrough (live, needs ADO_PAT)', function () {
  this.timeout(180000);
  let bench;

  before(async function () {
    this.timeout(120000);
    bench = new Workbench();
    await VSBrowser.instance.openResources(WS);
    await VSBrowser.instance.waitForWorkbench();
    await sleep(3000);
    await shot('01-workspace-open');
    await dismissModals();
    await shot('01b-after-dismiss');
  });

  // Recent VS Code shows a "Sign in to use GitHub Copilot" onboarding overlay
  // (div.onboarding-a-overlay, aria-modal) that ignores Escape and intercepts
  // every click. Dismiss it by clicking its close button / "Continue without
  // Signing In" link via the DOM, then close any leftover welcome editor tabs.
  async function dismissModals() {
    const driver = VSBrowser.instance.driver;
    for (let attempt = 0; attempt < 5; attempt++) {
      const overlays = await driver.findElements({ css: '.onboarding-a-overlay' });
      if (overlays.length === 0) {
        break;
      }
      const closers = await driver.findElements({
        css: '.onboarding-a-overlay .codicon-close, .onboarding-a-overlay a, .onboarding-a-overlay .button-link',
      });
      let clicked = false;
      for (const el of closers) {
        try {
          const txt = (await el.getText()).toLowerCase();
          if (txt.includes('continue without') || (await el.getAttribute('class')).includes('codicon-close')) {
            await el.click();
            clicked = true;
            break;
          }
        } catch (_) {
          // element went stale; retry
        }
      }
      if (!clicked && closers.length > 0) {
        try { await closers[0].click(); } catch (_) {}
      }
      await sleep(800);
    }
    try {
      await new EditorView().closeAllEditors();
    } catch (_) {
      // no editors open
    }
    await sleep(500);
  }

  it('signs in with the PAT', async function () {
    await bench.executeCommand('ReviewLens: Sign in (PAT)');
    const input = await InputBox.create();
    await input.setText(PAT);
    await input.confirm();
    await sleep(1500);
    await shot('02-after-signin');
  });

  it('attaches to the branch PR and lists changed files', async function () {
    await bench.executeCommand('ReviewLens: Show PR comments for current branch');
    // Give the ADO round trip + tree render time.
    await sleep(6000);
    await shot('03-attached-changed-files');

    // Open the ReviewLens view container so the Changed Files tree is visible.
    const activity = new ActivityBar();
    const control = await activity.getViewControl('ReviewLens');
    if (control) {
      await control.openView();
      await sleep(2000);
      await shot('04-changed-files-tree');
    }
  });

  it('jumps to the next changed file (nextFile)', async function () {
    for (let i = 1; i <= 3; i++) {
      await bench.executeCommand('ReviewLens: Next changed file');
      await sleep(2500);
      await shot(`05-nextfile-${i}`);
    }
    const titles = await new EditorView().getOpenEditorTitles();
    assert.ok(titles.length > 0, 'expected an editor to be open after nextFile');
  });

  it('jumps to the next change within the diff (nextChange)', async function () {
    for (let i = 1; i <= 3; i++) {
      await bench.executeCommand('ReviewLens: Next change');
      await sleep(2000);
      await shot(`06-nextchange-${i}`);
    }
  });

  it('jumps to the previous changed file (prevFile)', async function () {
    await bench.executeCommand('ReviewLens: Previous changed file');
    await sleep(2500);
    await shot('07-prevfile');
  });

  it('jumps between comments (nextComment)', async function () {
    await bench.executeCommand('ReviewLens: Next comment');
    await sleep(2500);
    await shot('08-nextcomment');
  });
});
