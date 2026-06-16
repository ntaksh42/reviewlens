const assert = require('assert');
const path = require('path');
const { normalizeAnchorText, resolveAnchorLine, REANCHOR_WINDOW } = require(
  path.resolve(__dirname, '../../dist/test/anchor.js')
);

// Helper: build a lineAt() over an array of raw lines, normalizing like the
// real CommentsController does before comparing to the snapshot.
function docOf(rawLines) {
  const norm = rawLines.map(normalizeAnchorText);
  const lineAt = (i) => (i >= 0 && i < norm.length ? norm[i] : '');
  return { count: rawLines.length, lineAt };
}
const resolve = (raw, stored, snap) => {
  const d = docOf(raw);
  return resolveAnchorLine(d.count, d.lineAt, stored, snap);
};

describe('normalizeAnchorText', () => {
  it('collapses internal whitespace and trims', () => {
    assert.strictEqual(normalizeAnchorText('  const   x =\t1 '), 'const x = 1');
  });
  it('maps blank/whitespace-only lines to empty string', () => {
    assert.strictEqual(normalizeAnchorText('   '), '');
    assert.strictEqual(normalizeAnchorText(''), '');
  });
});

describe('resolveAnchorLine (FR-10 re-anchoring)', () => {
  const lines = ['function a() {', '  return 1;', '}', '', 'const z = 2;'];

  it('drift "none" when the stored line still matches', () => {
    const r = resolve(lines, 1, normalizeAnchorText('  return 1;'));
    assert.deepStrictEqual(r, { line: 1, drift: 'none' });
  });

  it('drift "none" when there is no snapshot text', () => {
    const r = resolve(lines, 2, undefined);
    assert.deepStrictEqual(r, { line: 2, drift: 'none' });
  });

  it('drift "moved" when the line shifted down', () => {
    // snapshot is "const z = 2;" but stored points at line 1; it now lives at 4.
    const r = resolve(lines, 1, normalizeAnchorText('const z = 2;'));
    assert.deepStrictEqual(r, { line: 4, drift: 'moved' });
  });

  it('drift "moved" when the line shifted up', () => {
    const r = resolve(lines, 4, normalizeAnchorText('function a() {'));
    assert.deepStrictEqual(r, { line: 0, drift: 'moved' });
  });

  it('drift "lost" when the remembered text is gone', () => {
    const r = resolve(lines, 2, normalizeAnchorText('totally different line'));
    assert.deepStrictEqual(r, { line: 2, drift: 'lost' });
  });

  it('prefers the nearest match when the text appears more than once', () => {
    const dup = ['x', 'target', 'a', 'b', 'target', 'c'];
    // stored at 3; "target" is at 1 (delta 2) and 4 (delta 1) -> nearest is 4.
    const r = resolve(dup, 3, 'target');
    assert.deepStrictEqual(r, { line: 4, drift: 'moved' });
  });

  it('on equal distance the upward candidate wins (searched first)', () => {
    const dup = ['target', 'a', 'b', 'a', 'target'];
    // stored at 2; "target" at 0 and 4, both delta 2 -> upward (0) checked first.
    const r = resolve(dup, 2, 'target');
    assert.deepStrictEqual(r, { line: 0, drift: 'moved' });
  });

  it('clamps an out-of-range stored line before matching', () => {
    const r = resolve(lines, 999, normalizeAnchorText('const z = 2;'));
    // clamped to last line (4) which happens to match -> none.
    assert.deepStrictEqual(r, { line: 4, drift: 'none' });
  });

  it('clamps a negative stored line to 0', () => {
    const r = resolve(lines, -5, normalizeAnchorText('function a() {'));
    assert.deepStrictEqual(r, { line: 0, drift: 'none' });
  });

  it('does not match a blank snapshot against blank lines', () => {
    // snapshotText '' is falsy, so it is treated as "no snapshot" -> none at stored.
    const r = resolve(lines, 3, '');
    assert.deepStrictEqual(r, { line: 3, drift: 'none' });
  });

  it('does not search beyond REANCHOR_WINDOW', () => {
    const far = new Array(REANCHOR_WINDOW + 50).fill('x');
    far[0] = 'needle';
    // stored near the end; needle is >WINDOW lines away -> lost.
    const r = resolve(far, far.length - 1, 'needle');
    assert.strictEqual(r.drift, 'lost');
  });

  it('finds a match exactly at the window edge', () => {
    const edge = new Array(REANCHOR_WINDOW + 5).fill('x');
    const stored = 2;
    edge[stored + REANCHOR_WINDOW] = 'needle';
    const r = resolve(edge, stored, 'needle');
    assert.deepStrictEqual(r, { line: stored + REANCHOR_WINDOW, drift: 'moved' });
  });
});
