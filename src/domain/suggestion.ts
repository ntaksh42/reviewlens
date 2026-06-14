// Pure helpers for the suggestion + sync features. No vscode/ADO imports, so
// they can be unit-tested against fixtures.

import { Thread } from './models';

/**
 * Extract the body of the first ```suggestion fenced block from a comment, or
 * undefined if there is none. The trailing newline before the closing fence is
 * dropped so the replacement text matches what the user typed.
 */
export function extractSuggestion(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const m = /```suggestion[^\n]*\n([\s\S]*?)\n?```/.exec(content);
  return m ? m[1] : undefined;
}

/**
 * Stable fingerprint of all threads, to detect a change after a re-fetch (used
 * by the background sync to decide whether a re-render is needed).
 */
export function threadsSignature(threads: Thread[]): string {
  return threads
    .map(
      (t) =>
        `${t.id}:${t.status}:${t.comments.map((c) => `${c.id}#${c.content.length}`).join(',')}`
    )
    .join('|');
}
