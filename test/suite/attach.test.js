const assert = require('assert');
const path = require('path');
const { branchKey, shouldAutoAttach, normalizeSyncInterval } = require(
  path.resolve(__dirname, '../../dist/test/attach.js')
);

describe('branchKey', () => {
  it('joins repo root and branch with #', () => {
    assert.strictEqual(branchKey('/repo', 'feature/x'), '/repo#feature/x');
  });

  it('distinguishes the same branch in different repos', () => {
    assert.notStrictEqual(branchKey('/a', 'main'), branchKey('/b', 'main'));
  });

  it('distinguishes different branches in the same repo', () => {
    assert.notStrictEqual(branchKey('/r', 'main'), branchKey('/r', 'dev'));
  });
});

describe('shouldAutoAttach', () => {
  const key = branchKey('/r', 'feat');

  it('attaches a fresh, never-tried branch', () => {
    assert.strictEqual(shouldAutoAttach(key, undefined, undefined), true);
  });

  it('skips when already attached to this branch', () => {
    assert.strictEqual(shouldAutoAttach(key, key, undefined), false);
  });

  it('skips when already tried this branch (no PR found)', () => {
    assert.strictEqual(shouldAutoAttach(key, undefined, key), false);
  });

  it('attaches a different branch even if another is attached', () => {
    const other = branchKey('/r', 'main');
    assert.strictEqual(shouldAutoAttach(key, other, other), true);
  });
});

describe('normalizeSyncInterval', () => {
  it('keeps a positive interval', () => {
    assert.strictEqual(normalizeSyncInterval(30), 30);
  });

  it('disables polling for zero', () => {
    assert.strictEqual(normalizeSyncInterval(0), 0);
  });

  it('disables polling for a negative value', () => {
    assert.strictEqual(normalizeSyncInterval(-5), 0);
  });

  it('disables polling for NaN / Infinity', () => {
    assert.strictEqual(normalizeSyncInterval(NaN), 0);
    assert.strictEqual(normalizeSyncInterval(Infinity), 0);
  });
});
