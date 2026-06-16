const assert = require('assert');
const path = require('path');
const { oneLine, voteLabel } = require(
  path.resolve(__dirname, '../../dist/test/labels.js')
);

describe('oneLine', () => {
  it('collapses internal whitespace runs to a single space', () => {
    assert.strictEqual(oneLine('a   b\t\tc'), 'a b c');
  });

  it('flattens newlines and trims the ends', () => {
    assert.strictEqual(oneLine('  first\nsecond  \n  third '), 'first second third');
  });

  it('is empty for whitespace-only input', () => {
    assert.strictEqual(oneLine('  \n\t '), '');
  });
});

describe('voteLabel', () => {
  it('labels every vote variant', () => {
    assert.strictEqual(voteLabel('approve'), 'approved');
    assert.strictEqual(voteLabel('approveWithSuggestions'), 'approved with suggestions');
    assert.strictEqual(voteLabel('waitForAuthor'), 'marked “wait for the author”');
    assert.strictEqual(voteLabel('reject'), 'rejected');
    assert.strictEqual(voteLabel('reset'), 'vote reset');
  });
});
