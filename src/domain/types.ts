// Pure domain enums/aliases. No vscode or ADO dependencies.

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type ThreadStatus =
  | 'active'
  | 'fixed'
  | 'wontFix'
  | 'closed'
  | 'pending'
  | 'byDesign';

export type FileOrder = 'ado' | 'logical';

export type Side = 'left' | 'right';

/**
 * A reviewer's verdict on a pull request, mapped to ADO's numeric votes
 * (10 / 5 / 0 / -5 / -10). `reset` clears a prior vote.
 */
export type PrVote =
  | 'approve'
  | 'approveWithSuggestions'
  | 'waitForAuthor'
  | 'reject'
  | 'reset';
