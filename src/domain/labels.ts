import { PrVote } from './types';

/** Collapse a multi-line string to a single trimmed line, for list labels. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Human-readable confirmation shown after a vote is recorded. */
export function voteLabel(vote: PrVote): string {
  switch (vote) {
    case 'approve':
      return 'approved';
    case 'approveWithSuggestions':
      return 'approved with suggestions';
    case 'waitForAuthor':
      return 'marked “wait for the author”';
    case 'reject':
      return 'rejected';
    case 'reset':
      return 'vote reset';
  }
}
