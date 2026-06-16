import { Thread } from './models';

/** A head-side cursor position used as the origin for "next/prev from here". */
export interface CommentLocation {
  filePath: string;
  line: number;
}

/**
 * Anchored threads in stable traversal order: by file path, then by anchor line.
 * Threads without an anchor (file/PR-level) are dropped; `unresolvedOnly` keeps
 * only threads that aren't closed. This is the order both the keyboard jump and
 * the search picker traverse, so it lives here as a pure helper (SPEC FR-12).
 */
export function sortAnchoredThreads(threads: Thread[], unresolvedOnly = false): Thread[] {
  return threads
    .filter((t) => t.anchor && (!unresolvedOnly || t.status !== 'closed'))
    .sort((a, b) => {
      const fa = a.anchor!.filePath;
      const fb = b.anchor!.filePath;
      return fa === fb ? a.anchor!.start.line - b.anchor!.start.line : fa.localeCompare(fb);
    });
}

function isAfter(t: Thread, here: CommentLocation | undefined): boolean {
  if (!here) {
    return true;
  }
  const a = t.anchor!;
  return a.filePath > here.filePath || (a.filePath === here.filePath && a.start.line > here.line);
}

function samePosition(t: Thread, here: CommentLocation | undefined): boolean {
  return (
    here != null &&
    t.anchor != null &&
    t.anchor.filePath === here.filePath &&
    t.anchor.start.line === here.line
  );
}

/**
 * Choose the next/prev comment to jump to from `here`, wrapping at the ends.
 * `list` must already be in traversal order (see sortAnchoredThreads). Returns
 * undefined only for an empty list. With no origin, "next" starts at the first
 * thread and "prev" at the last.
 */
export function pickComment(
  list: Thread[],
  here: CommentLocation | undefined,
  dir: 'next' | 'prev'
): Thread | undefined {
  if (list.length === 0) {
    return undefined;
  }
  if (dir === 'next') {
    return list.find((t) => isAfter(t, here)) ?? list[0];
  }
  const before = list.filter((t) => !isAfter(t, here) && !samePosition(t, here));
  return before[before.length - 1] ?? list[list.length - 1];
}
