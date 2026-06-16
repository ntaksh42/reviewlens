/** Where a thread ended up relative to its stored anchor (FR-10). */
export type Drift = 'none' | 'moved' | 'lost';

/** How far to search for a drifted anchor line, in each direction. */
export const REANCHOR_WINDOW = 200;

/** Whitespace-collapsed line text; '' for blank lines (never used as an anchor). */
export function normalizeAnchorText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Decide which line a comment should render on after the head may have drifted
 * (FR-10). `lineAt(n)` returns the already-normalized text of 0-based line n, or
 * '' when out of range. `lineCount` bounds the document.
 *
 * - Prefer the stored line when its text still matches the snapshot ('none').
 * - Else search ±REANCHOR_WINDOW for the remembered text, nearest first
 *   ('moved'); the stored line is clamped into range before searching.
 * - Else keep the (clamped) stored line ('lost').
 *
 * With no snapshot text there is nothing to match against, so the stored line is
 * kept as-is ('none').
 */
export function resolveAnchorLine(
  lineCount: number,
  lineAt: (line0: number) => string,
  storedLine0: number,
  snapshotText: string | undefined
): { line: number; drift: Drift } {
  const last = Math.max(0, lineCount - 1);
  const stored = Math.min(Math.max(0, storedLine0), last);
  if (!snapshotText) {
    return { line: stored, drift: 'none' };
  }
  if (lineAt(stored) === snapshotText) {
    return { line: stored, drift: 'none' };
  }
  // Walk outward from the stored line so the nearest match wins ties.
  for (let delta = 1; delta <= REANCHOR_WINDOW; delta++) {
    for (const candidate of [stored - delta, stored + delta]) {
      if (candidate >= 0 && candidate <= last && lineAt(candidate) === snapshotText) {
        return { line: candidate, drift: 'moved' };
      }
    }
  }
  return { line: stored, drift: 'lost' };
}
