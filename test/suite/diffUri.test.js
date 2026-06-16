const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const vscode = require('vscode');
const {
  DIFF_SCHEME,
  sideUri,
  headUri,
  headDocPath,
  parseRightUri,
} = require(path.resolve(__dirname, '../../dist/test/diffContentProvider.js'));

describe('diff URI helpers', () => {
  describe('sideUri', () => {
    it('encodes scheme, side, prId and path', () => {
      const uri = sideUri(67, 'right', 'src/calc.ts');
      assert.strictEqual(uri.scheme, DIFF_SCHEME);
      assert.strictEqual(uri.path, '/right/67/src/calc.ts');
    });

    it('distinguishes left and right sides', () => {
      const l = sideUri(5, 'left', 'a.ts').toString();
      const r = sideUri(5, 'right', 'a.ts').toString();
      assert.notStrictEqual(l, r);
    });
  });

  describe('parseRightUri', () => {
    it('round-trips a right-side sideUri', () => {
      const uri = sideUri(67, 'right', 'src/dir/calc.ts');
      assert.deepStrictEqual(parseRightUri(uri), { prId: 67, filePath: 'src/dir/calc.ts' });
    });

    it('returns undefined for the left side', () => {
      assert.strictEqual(parseRightUri(sideUri(67, 'left', 'a.ts')), undefined);
    });

    it('returns undefined for a non-reviewlens scheme', () => {
      assert.strictEqual(parseRightUri(vscode.Uri.file('/tmp/a.ts')), undefined);
    });

    it('returns undefined when the prId is missing/zero', () => {
      assert.strictEqual(parseRightUri(sideUri(0, 'right', 'a.ts')), undefined);
    });
  });

  describe('headUri', () => {
    it('falls back to the virtual right-side doc when no localPath', () => {
      const uri = headUri(67, 'src/a.ts', undefined);
      assert.strictEqual(uri.scheme, DIFF_SCHEME);
      assert.strictEqual(uri.path, '/right/67/src/a.ts');
    });

    it('falls back to virtual when the file is not on disk', () => {
      const uri = headUri(67, 'does/not/exist.ts', os.tmpdir());
      assert.strictEqual(uri.scheme, DIFF_SCHEME);
    });

    it('uses the real file URI when it exists on disk', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-uri-'));
      fs.writeFileSync(path.join(dir, 'real.ts'), 'x');
      const uri = headUri(67, 'real.ts', dir);
      assert.strictEqual(uri.scheme, 'file');
      // vscode.Uri.file lowercases the Windows drive letter, so compare
      // case-insensitively rather than against the raw temp path.
      assert.strictEqual(uri.fsPath.toLowerCase(), path.join(dir, 'real.ts').toLowerCase());
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('headDocPath', () => {
    it('reads the path back from a virtual head URI', () => {
      assert.strictEqual(headDocPath(sideUri(67, 'right', 'src/a.ts'), undefined), 'src/a.ts');
    });

    it('returns a repo-relative POSIX path for a file under localPath', () => {
      const root = os.tmpdir();
      const fileUri = vscode.Uri.file(path.join(root, 'src', 'a.ts'));
      assert.strictEqual(headDocPath(fileUri, root), 'src/a.ts');
    });

    it('returns undefined for a file outside localPath', () => {
      const fileUri = vscode.Uri.file(path.join(os.tmpdir(), 'elsewhere', 'a.ts'));
      const otherRoot = path.join(os.tmpdir(), 'project-root');
      assert.strictEqual(headDocPath(fileUri, otherRoot), undefined);
    });

    it('returns undefined for a file scheme with no localPath', () => {
      assert.strictEqual(headDocPath(vscode.Uri.file('/tmp/a.ts'), undefined), undefined);
    });
  });
});
