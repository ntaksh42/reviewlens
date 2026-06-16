const assert = require('assert');
const path = require('path');
const { mapChangeEntries } = require(path.resolve(__dirname, '../../dist/test/adoClient.js'));

// VersionControlChangeType bit flags (azure-devops-node-api GitInterfaces).
const ADD = 1;
const EDIT = 2;
const DELETE = 16;

describe('mapChangeEntries', () => {
  it('returns [] for undefined / empty', () => {
    assert.deepStrictEqual(mapChangeEntries(undefined), []);
    assert.deepStrictEqual(mapChangeEntries([]), []);
  });

  it('maps an added file', () => {
    const files = mapChangeEntries([{ changeType: ADD, item: { path: '/src/index.ts' } }]);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, 'src/index.ts');
    assert.strictEqual(files[0].status, 'added');
  });

  it('maps an edited file', () => {
    const files = mapChangeEntries([{ changeType: EDIT, item: { path: '/README.md' } }]);
    assert.strictEqual(files[0].status, 'modified');
  });

  // Regression: deletes carry no item.path — the path is in originalPath. A
  // naive item.path filter dropped removed files from the changed-files tree
  // entirely (found via E2E against a real PR).
  it('maps a deleted file via originalPath (item.path is null)', () => {
    const files = mapChangeEntries([
      { changeType: DELETE, item: { path: null, originalObjectId: 'abc' }, originalPath: '/piyo.txt' },
    ]);
    assert.strictEqual(files.length, 1, 'deleted file must not be dropped');
    assert.strictEqual(files[0].path, 'piyo.txt');
    assert.strictEqual(files[0].status, 'deleted');
  });

  it('strips a single leading slash from paths', () => {
    const files = mapChangeEntries([{ changeType: ADD, item: { path: '/a/b/c.ts' } }]);
    assert.strictEqual(files[0].path, 'a/b/c.ts');
  });

  it('skips folder entries', () => {
    const files = mapChangeEntries([
      { changeType: ADD, item: { path: '/src', isFolder: true } },
      { changeType: ADD, item: { path: '/src/index.ts' } },
    ]);
    assert.deepStrictEqual(files.map((f) => f.path), ['src/index.ts']);
  });

  it('skips entries with neither path nor originalPath', () => {
    const files = mapChangeEntries([{ changeType: EDIT, item: {} }]);
    assert.deepStrictEqual(files, []);
  });

  it('maps a mixed change set (the shape PR #68 produces)', () => {
    const entries = [
      { changeType: ADD, item: { path: '/src/index.ts' } },
      { changeType: ADD, item: { path: '/src/server.ts' } },
      { changeType: EDIT, item: { path: '/README.md' } },
      { changeType: DELETE, item: { path: null }, originalPath: '/piyo.txt' },
    ];
    const files = mapChangeEntries(entries);
    const byStatus = files.reduce((a, f) => ((a[f.status] = (a[f.status] || 0) + 1), a), {});
    assert.deepStrictEqual(byStatus, { added: 2, modified: 1, deleted: 1 });
  });

  it('initializes review fields (hunks/viewed/riskScore)', () => {
    const f = mapChangeEntries([{ changeType: ADD, item: { path: '/x.ts' } }])[0];
    assert.deepStrictEqual(f.hunks, []);
    assert.strictEqual(f.viewed, false);
    assert.strictEqual(f.riskScore, null);
  });
});
