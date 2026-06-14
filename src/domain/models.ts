// Domain model (SPEC §8). Pure data shapes — no vscode/ADO imports.

import { FileStatus, FileOrder, Side, ThreadStatus } from './types';

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface Hunk {
  baseRange: LineRange;
  headRange: LineRange;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  hunks: Hunk[];
  viewed: boolean;
  /** Reserved for Phase 3 (AI). Null until then. */
  riskScore: number | null;
}

/** Maps to ADO threadContext. null anchor = file/PR-level comment. */
export interface Anchor {
  filePath: string;
  side: Side;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
  /** Anchor-line + context hash, for re-anchoring across iterations. */
  contextHash?: string;
}

export interface Comment {
  id?: string;
  author: string;
  content: string;
  publishedAt?: string;
  inReplyToId?: string;
}

export interface Thread {
  /** null = local draft not yet published to ADO. */
  id: string | null;
  /** null = file/PR-level (no line anchor). */
  anchor: Anchor | null;
  status: ThreadStatus;
  comments: Comment[];
  iterationId?: number;
  isDraft: boolean;
}

export interface ReviewProgress {
  viewedPaths: Set<string>;
  fileOrder: FileOrder;
  lastSeenIterationId?: number;
}

/** Lightweight PR row for the list view (M0). */
export interface PullRequestSummary {
  id: number;
  title: string;
  author: string;
  project: string;
  repository: string;
  repositoryId: string;
  /** Clone URL of the repo, used to match the PR to a local checkout. */
  remoteUrl: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
}

/** Data needed to review a PR's diffs (M1a). */
export interface ReviewData {
  repositoryId: string;
  /** Merge-base commit (left/base side). */
  baseCommit?: string;
  /** PR source commit (right/head side). */
  headCommit?: string;
  files: ChangedFile[];
}

/** A single PR being reviewed (M1+). */
export interface ReviewSession {
  prId: number;
  repositoryId: string;
  projectId: string;
  baseSha: string;
  headSha: string;
  currentIterationId: number;
  files: ChangedFile[];
  threads: Thread[];
  progress: ReviewProgress;
}
