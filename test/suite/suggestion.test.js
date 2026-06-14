const assert = require('assert');
const path = require('path');
const { extractSuggestion, threadsSignature } = require(
  path.resolve(__dirname, '../../dist/test/suggestion.js')
);
const fx = require('../fixtures/threads');

describe('extractSuggestion', () => {
  it('returns undefined when there is no suggestion block', () => {
    assert.strictEqual(extractSuggestion(fx.plainThread.comments[0].content), undefined);
  });

  it('returns undefined for empty/missing content', () => {
    assert.strictEqual(extractSuggestion(undefined), undefined);
    assert.strictEqual(extractSuggestion(''), undefined);
  });

  it('extracts a single-line suggestion body', () => {
    const body = extractSuggestion(fx.singleLineSuggestion.comments[0].content);
    assert.strictEqual(body, 'const total = a + b;');
  });

  it('extracts a multi-line suggestion body preserving inner newlines', () => {
    const body = extractSuggestion(fx.multiLineSuggestion.comments[0].content);
    assert.strictEqual(body, 'if (x > 0) {\n  return x;\n}');
  });

  it('ignores text after the suggestion fence and prose before it', () => {
    const body = extractSuggestion(fx.singleLineSuggestion.comments[0].content);
    assert.ok(!body.includes('Use a clearer name'));
  });
});

describe('threadsSignature', () => {
  it('is stable for identical thread sets', () => {
    assert.strictEqual(threadsSignature(fx.all), threadsSignature(fx.all));
  });

  it('changes when a thread status changes', () => {
    const before = threadsSignature([fx.plainThread]);
    const reopened = { ...fx.plainThread, status: 'closed' };
    assert.notStrictEqual(threadsSignature([reopened]), before);
  });

  it('changes when a comment is added', () => {
    const before = threadsSignature([fx.plainThread]);
    const withReply = {
      ...fx.plainThread,
      comments: [...fx.plainThread.comments, { id: '9', author: 'X', content: 'a reply' }],
    };
    assert.notStrictEqual(threadsSignature([withReply]), before);
  });

  it('changes when a comment body is edited', () => {
    const before = threadsSignature([fx.plainThread]);
    const edited = {
      ...fx.plainThread,
      comments: [{ ...fx.plainThread.comments[0], content: 'a much longer edited body' }],
    };
    assert.notStrictEqual(threadsSignature([edited]), before);
  });

  it('changes when a same-length edit swaps the body (hashes, not length)', () => {
    const original = fx.plainThread.comments[0].content;
    const swapped = 'X'.repeat(original.length); // identical length, different text
    const before = threadsSignature([fx.plainThread]);
    const edited = {
      ...fx.plainThread,
      comments: [{ ...fx.plainThread.comments[0], content: swapped }],
    };
    assert.strictEqual(swapped.length, original.length);
    assert.notStrictEqual(threadsSignature([edited]), before);
  });

  it('changes when a thread is re-anchored to a different line', () => {
    const before = threadsSignature([fx.plainThread]);
    const moved = {
      ...fx.plainThread,
      anchor: {
        ...fx.plainThread.anchor,
        start: { ...fx.plainThread.anchor.start, line: fx.plainThread.anchor.start.line + 5 },
      },
    };
    assert.notStrictEqual(threadsSignature([moved]), before);
  });

  it('is empty for no threads', () => {
    assert.strictEqual(threadsSignature([]), '');
  });
});
