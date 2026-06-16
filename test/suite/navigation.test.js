const assert = require('assert');
const path = require('path');
const { sortAnchoredThreads, pickComment } = require(
  path.resolve(__dirname, '../../dist/test/navigation.js')
);

// Minimal Thread builder: anchored at file:line with a status.
let seq = 0;
function thread(filePath, line, status = 'active') {
  return {
    id: String(++seq),
    anchor: { filePath, side: 'right', start: { line, offset: 1 }, end: { line, offset: 1 } },
    status,
    comments: [{ author: 'x', content: 'c' }],
    isDraft: false,
  };
}
function fileLevel() {
  return { id: String(++seq), anchor: null, status: 'active', comments: [], isDraft: false };
}
const at = (filePath, line) => ({ filePath, line });
const ids = (list) => list.map((t) => `${t.anchor.filePath}:${t.anchor.start.line}`);

describe('sortAnchoredThreads', () => {
  it('orders by file path, then by line', () => {
    const list = sortAnchoredThreads([thread('b.ts', 5), thread('a.ts', 20), thread('a.ts', 3)]);
    assert.deepStrictEqual(ids(list), ['a.ts:3', 'a.ts:20', 'b.ts:5']);
  });

  it('drops threads with no anchor (file/PR-level)', () => {
    const list = sortAnchoredThreads([thread('a.ts', 1), fileLevel()]);
    assert.strictEqual(list.length, 1);
  });

  it('unresolvedOnly keeps non-closed threads only', () => {
    const list = sortAnchoredThreads(
      [thread('a.ts', 1, 'closed'), thread('a.ts', 2, 'active'), thread('a.ts', 3, 'fixed')],
      true
    );
    assert.deepStrictEqual(ids(list), ['a.ts:2', 'a.ts:3']); // closed dropped, fixed kept
  });
});

describe('pickComment (jump to next/prev comment)', () => {
  const list = sortAnchoredThreads([thread('a.ts', 5), thread('a.ts', 20), thread('b.ts', 8)]);

  it('returns undefined for an empty list', () => {
    assert.strictEqual(pickComment([], at('a.ts', 1), 'next'), undefined);
    assert.strictEqual(pickComment([], undefined, 'prev'), undefined);
  });

  it('next with no origin starts at the first thread', () => {
    assert.strictEqual(pickComment(list, undefined, 'next').anchor.start.line, 5);
  });

  it('prev with no origin starts at the last thread', () => {
    const t = pickComment(list, undefined, 'prev');
    assert.strictEqual(t.anchor.filePath, 'b.ts');
  });

  it('next jumps to the first thread strictly after the cursor', () => {
    const t = pickComment(list, at('a.ts', 5), 'next'); // sitting on a.ts:5
    assert.strictEqual(t.anchor.start.line, 20); // -> next is a.ts:20, not itself
  });

  it('next crosses into the following file', () => {
    const t = pickComment(list, at('a.ts', 20), 'next');
    assert.strictEqual(t.anchor.filePath, 'b.ts');
    assert.strictEqual(t.anchor.start.line, 8);
  });

  it('next wraps from the end back to the first', () => {
    const t = pickComment(list, at('b.ts', 8), 'next');
    assert.strictEqual(t.anchor.filePath, 'a.ts');
    assert.strictEqual(t.anchor.start.line, 5);
  });

  it('prev jumps to the thread strictly before the cursor', () => {
    const t = pickComment(list, at('a.ts', 20), 'prev'); // on a.ts:20
    assert.strictEqual(t.anchor.start.line, 5);
  });

  it('prev skips a thread sitting exactly on the cursor', () => {
    // on a.ts:20 exactly -> prev should not return a.ts:20 itself.
    const t = pickComment(list, at('a.ts', 20), 'prev');
    assert.notStrictEqual(t.anchor.start.line, 20);
  });

  it('prev wraps from the start back to the last', () => {
    const t = pickComment(list, at('a.ts', 5), 'prev');
    assert.strictEqual(t.anchor.filePath, 'b.ts'); // wraps to last
  });

  it('cursor between threads picks the right neighbours', () => {
    assert.strictEqual(pickComment(list, at('a.ts', 10), 'next').anchor.start.line, 20);
    assert.strictEqual(pickComment(list, at('a.ts', 10), 'prev').anchor.start.line, 5);
  });

  it('unresolved-only traversal skips resolved comments end to end', () => {
    const mixed = sortAnchoredThreads(
      [thread('a.ts', 5, 'closed'), thread('a.ts', 10, 'active'), thread('a.ts', 15, 'closed')],
      true
    );
    // only a.ts:10 remains; next from before it lands there, and wraps to itself.
    assert.strictEqual(pickComment(mixed, at('a.ts', 1), 'next').anchor.start.line, 10);
    assert.strictEqual(pickComment(mixed, at('a.ts', 10), 'next').anchor.start.line, 10);
  });
});
