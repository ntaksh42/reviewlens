// Sample ADO comment-thread data shaped like the domain `Thread` model
// (src/domain/models.ts). Used by the suggestion/sync unit tests so they don't
// need a live Azure DevOps connection.

/** A plain review comment with no suggestion block. */
const plainThread = {
  id: '101',
  anchor: {
    filePath: 'src/calc.ts',
    side: 'right',
    start: { line: 12, offset: 1 },
    end: { line: 12, offset: 20 },
  },
  status: 'active',
  comments: [
    { id: '1', author: 'Reviewer A', content: 'Consider renaming this variable.' },
  ],
  isDraft: false,
};

/** A single-line suggestion: replace line 12 with `const total = a + b;`. */
const singleLineSuggestion = {
  id: '102',
  anchor: {
    filePath: 'src/calc.ts',
    side: 'right',
    start: { line: 12, offset: 1 },
    end: { line: 12, offset: 20 },
  },
  status: 'active',
  comments: [
    {
      id: '2',
      author: 'Reviewer B',
      content: 'Use a clearer name:\n```suggestion\nconst total = a + b;\n```',
    },
  ],
  isDraft: false,
};

/** A multi-line suggestion spanning lines 5-7. */
const multiLineSuggestion = {
  id: '103',
  anchor: {
    filePath: 'src/calc.ts',
    side: 'right',
    start: { line: 5, offset: 1 },
    end: { line: 7, offset: 1 },
  },
  status: 'active',
  comments: [
    {
      id: '3',
      author: 'Reviewer B',
      content: '```suggestion\nif (x > 0) {\n  return x;\n}\n```',
    },
  ],
  isDraft: false,
};

/** A resolved (closed) thread, to exercise the status field in signatures. */
const resolvedThread = {
  id: '104',
  anchor: {
    filePath: 'src/util.ts',
    side: 'right',
    start: { line: 3, offset: 1 },
    end: { line: 3, offset: 1 },
  },
  status: 'closed',
  comments: [{ id: '4', author: 'Reviewer A', content: 'Done, thanks.' }],
  isDraft: false,
};

module.exports = {
  plainThread,
  singleLineSuggestion,
  multiLineSuggestion,
  resolvedThread,
  all: [plainThread, singleLineSuggestion, multiLineSuggestion, resolvedThread],
};
