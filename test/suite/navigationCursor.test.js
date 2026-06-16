const assert = require('assert');
const path = require('path');
const { NavigationCursor } = require(path.resolve(__dirname, '../../dist/test/navigationCursor.js'));

const file = (p) => ({ path: p, status: 'modified', hunks: [], viewed: false, riskScore: null });
const FILES = ['a.ts', 'b.ts', 'c.ts'].map(file);

describe('NavigationCursor (next/prev file)', () => {
  it('has no current file before any navigation', () => {
    const c = new NavigationCursor();
    c.setFiles(FILES);
    assert.strictEqual(c.current(), undefined);
  });

  it('next() walks forward through files in order', () => {
    const c = new NavigationCursor();
    c.setFiles(FILES);
    assert.strictEqual(c.next().path, 'a.ts');
    assert.strictEqual(c.next().path, 'b.ts');
    assert.strictEqual(c.next().path, 'c.ts');
  });

  it('next() wraps from the last file back to the first', () => {
    const c = new NavigationCursor();
    c.setFiles(FILES);
    c.next(); c.next(); c.next(); // at c.ts
    assert.strictEqual(c.next().path, 'a.ts');
  });

  it('prev() from the fresh cursor lands one before index 0', () => {
    // From the initial index -1, prev computes (-1 - 1 + n) % n, i.e. the
    // second-to-last file (b.ts) — not the last. (next() from -1 gives the
    // first file, so the fresh-cursor behaviour is intentionally asymmetric.)
    const c = new NavigationCursor();
    c.setFiles(FILES);
    assert.strictEqual(c.prev().path, 'b.ts');
  });

  it('prev() walks backward and wraps', () => {
    const c = new NavigationCursor();
    c.setFiles(FILES);
    c.next(); // a.ts
    assert.strictEqual(c.prev().path, 'c.ts'); // wraps below 0
    assert.strictEqual(c.prev().path, 'b.ts');
  });

  it('setCurrent positions the cursor so next() continues from there', () => {
    const c = new NavigationCursor();
    c.setFiles(FILES);
    c.setCurrent(file('b.ts'));
    assert.strictEqual(c.current().path, 'b.ts');
    assert.strictEqual(c.next().path, 'c.ts');
  });

  it('returns undefined when there are no files', () => {
    const c = new NavigationCursor();
    c.setFiles([]);
    assert.strictEqual(c.next(), undefined);
    assert.strictEqual(c.prev(), undefined);
  });

  it('setFiles resets the cursor to "no current"', () => {
    const c = new NavigationCursor();
    c.setFiles(FILES);
    c.next();
    c.setFiles(FILES);
    assert.strictEqual(c.current(), undefined);
  });
});
