import * as azdev from 'azure-devops-node-api';
import { IGitApi } from 'azure-devops-node-api/GitApi';
import {
  CommentThreadStatus,
  CommentType,
  GitPullRequest,
  GitPullRequestCommentThread,
  GitPullRequestSearchCriteria,
  GitVersionType,
  PullRequestStatus,
  VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoConfig } from '../config';
import { ChangedFile, PullRequestSummary, ReviewData, Thread } from '../../domain/models';
import { FileStatus, PrVote, ThreadStatus } from '../../domain/types';

/** Character span (1-based line + column) for anchoring a comment. */
export interface CommentTarget {
  startLine: number;
  startOffset: number;
  endLine: number;
  endOffset: number;
}

/**
 * Thin wrapper over azure-devops-node-api. All ADO REST access goes through here
 * (SPEC §7.3).
 */
export class AdoClient {
  private readonly connection: azdev.WebApi;
  /**
   * Cached GitApi promise. The first getGitApi() on a connection does a
   * resource-area lookup round trip; memoizing it means every subsequent call
   * reuses that result instead of paying the round trip again.
   */
  private gitApi: Promise<IGitApi> | undefined;

  constructor(private readonly config: AdoConfig, pat: string) {
    const handler = azdev.getPersonalAccessTokenHandler(pat);
    this.connection = new azdev.WebApi(config.orgUrl, handler);
  }

  private git(): Promise<IGitApi> {
    if (!this.gitApi) {
      // Drop the memo if the lookup fails so a later call can retry instead of
      // replaying a poisoned rejected promise.
      this.gitApi = this.connection.getGitApi().catch((err) => {
        this.gitApi = undefined;
        throw err;
      });
    }
    return this.gitApi;
  }

  /**
   * Find the active PR whose source branch matches the open workspace branch, so
   * its comments can be shown inline on the working-tree files. Returns the most
   * recently created match when more than one PR targets the same source branch.
   */
  async findActivePrBySourceBranch(branch: string): Promise<PullRequestSummary | undefined> {
    const git = await this.git();
    const criteria: GitPullRequestSearchCriteria = {
      status: PullRequestStatus.Active,
      sourceRefName: `refs/heads/${branch}`,
    };
    const prs = this.config.repository
      ? await git.getPullRequests(this.config.repository, criteria, this.config.project)
      : await git.getPullRequestsByProject(this.config.project, criteria);
    if (!prs || prs.length === 0) {
      return undefined;
    }
    return this.toSummary(prs[0]);
  }

  private toSummary(pr: GitPullRequest): PullRequestSummary {
    return {
      id: pr.pullRequestId ?? 0,
      title: pr.title ?? '(no title)',
      author: pr.createdBy?.displayName ?? 'unknown',
      project: pr.repository?.project?.name ?? this.config.project,
      repository: pr.repository?.name ?? '',
      repositoryId: pr.repository?.id ?? '',
      remoteUrl: pr.repository?.remoteUrl ?? '',
      sourceBranch: shortBranch(pr.sourceRefName),
      targetBranch: shortBranch(pr.targetRefName),
      url: webUrl(this.config, pr.repository?.name, pr.pullRequestId),
    };
  }

  /** Changed files + base/head commits for the latest PR iteration (M1a). */
  async getReview(prId: number, repositoryId: string): Promise<ReviewData> {
    const git = await this.git();
    const iterations = await git.getPullRequestIterations(
      repositoryId,
      prId,
      this.config.project
    );
    const last = iterations[iterations.length - 1];
    const baseCommit =
      last?.commonRefCommit?.commitId ?? last?.targetRefCommit?.commitId;
    const headCommit = last?.sourceRefCommit?.commitId;

    const changes = await git.getPullRequestIterationChanges(
      repositoryId,
      prId,
      last?.id ?? 1,
      this.config.project
    );

    const files: ChangedFile[] = (changes.changeEntries ?? [])
      .filter((e) => e.item?.path && !e.item.isFolder)
      .map((e) => ({
        path: stripLead(e.item!.path!),
        status: mapStatus(e.changeType),
        hunks: [],
        viewed: false,
        riskScore: null,
      }));

    return { repositoryId, baseCommit, headCommit, files };
  }

  /** File text at a given commit. Empty string if the path does not exist there. */
  async getFileContent(repositoryId: string, path: string, commitId: string): Promise<string> {
    if (!commitId) {
      return '';
    }
    const git = await this.git();
    try {
      const item = await git.getItem(
        repositoryId,
        ensureLead(path),
        this.config.project,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { version: commitId, versionType: GitVersionType.Commit },
        true
      );
      return item?.content ?? '';
    } catch {
      return '';
    }
  }

  async getThreads(prId: number, repositoryId: string): Promise<Thread[]> {
    const git = await this.git();
    const threads = await git.getThreads(repositoryId, prId, this.config.project);
    return (threads ?? []).filter((t) => !t.isDeleted).map(mapThread);
  }

  /**
   * Create a thread anchored to a character span on the head (right) side.
   * Returns the new thread's id so its anchor can be snapshotted for
   * re-anchoring across iterations (FR-10, anchor drift).
   */
  async createComment(
    prId: number,
    repositoryId: string,
    filePath: string,
    target: CommentTarget,
    content: string
  ): Promise<number | undefined> {
    const git = await this.git();
    const thread: GitPullRequestCommentThread = {
      status: CommentThreadStatus.Active,
      comments: [{ parentCommentId: 0, content, commentType: CommentType.Text }],
      threadContext: {
        filePath: ensureLead(filePath),
        rightFileStart: { line: target.startLine, offset: target.startOffset },
        rightFileEnd: { line: target.endLine, offset: target.endOffset },
      },
    };
    const created = await git.createThread(thread, repositoryId, prId, this.config.project);
    return created?.id ?? undefined;
  }

  async replyToThread(
    prId: number,
    repositoryId: string,
    threadId: number,
    content: string
  ): Promise<void> {
    const git = await this.git();
    await git.createComment(
      { parentCommentId: 0, content, commentType: CommentType.Text },
      repositoryId,
      prId,
      threadId,
      this.config.project
    );
  }

  async setThreadStatus(
    prId: number,
    repositoryId: string,
    threadId: number,
    status: ThreadStatus
  ): Promise<void> {
    const git = await this.git();
    await git.updateThread(
      { status: toAdoStatus(status) },
      repositoryId,
      prId,
      threadId,
      this.config.project
    );
  }

  /**
   * Record the signed-in reviewer's vote on a PR (FR-20). A reviewer may only
   * set their own vote, so the vote is keyed to the authenticated user id.
   */
  async setVote(prId: number, repositoryId: string, vote: PrVote): Promise<void> {
    const git = await this.git();
    const reviewerId = await this.authenticatedUserId();
    await git.createPullRequestReviewer(
      { vote: voteValue(vote) },
      repositoryId,
      prId,
      reviewerId,
      this.config.project
    );
  }

  /** Abandon a PR (FR-21). */
  async abandonPullRequest(prId: number, repositoryId: string): Promise<void> {
    await this.updateStatus(prId, repositoryId, { status: PullRequestStatus.Abandoned });
  }

  /**
   * Complete (merge) a PR (FR-21). `headCommit` is required as the merge source;
   * ADO rejects completion without an explicit last-merge-source commit. The
   * merge strategy and branch deletion are left to ADO/branch policy defaults.
   */
  async completePullRequest(
    prId: number,
    repositoryId: string,
    headCommit: string
  ): Promise<void> {
    await this.updateStatus(prId, repositoryId, {
      status: PullRequestStatus.Completed,
      lastMergeSourceCommit: { commitId: headCommit },
    });
  }

  private async updateStatus(
    prId: number,
    repositoryId: string,
    update: GitPullRequest
  ): Promise<void> {
    const git = await this.git();
    await git.updatePullRequest(update, repositoryId, prId, this.config.project);
  }

  /** GUID of the PAT's owner, needed to attribute a reviewer vote. */
  private async authenticatedUserId(): Promise<string> {
    const data = await this.connection.connect();
    const id = data.authenticatedUser?.id;
    if (!id) {
      throw new Error('could not resolve the signed-in user — check the PAT.');
    }
    return id;
  }
}

/** Maps a reviewer verdict to ADO's numeric vote scale. */
function voteValue(vote: PrVote): number {
  switch (vote) {
    case 'approve':
      return 10;
    case 'approveWithSuggestions':
      return 5;
    case 'waitForAuthor':
      return -5;
    case 'reject':
      return -10;
    case 'reset':
      return 0;
  }
}

function mapThread(t: GitPullRequestCommentThread): Thread {
  const tc = t.threadContext;
  const anchor = tc?.filePath
    ? {
        filePath: stripLead(tc.filePath),
        side: 'right' as const,
        start: {
          line: tc.rightFileStart?.line ?? 1,
          offset: tc.rightFileStart?.offset ?? 1,
        },
        end: {
          line: tc.rightFileEnd?.line ?? tc.rightFileStart?.line ?? 1,
          offset: tc.rightFileEnd?.offset ?? 1,
        },
      }
    : null;
  return {
    id: t.id != null ? String(t.id) : null,
    anchor,
    status: fromAdoStatus(t.status),
    comments: (t.comments ?? [])
      .filter((c) => !c.isDeleted)
      .map((c) => ({
        id: c.id != null ? String(c.id) : undefined,
        author: c.author?.displayName ?? 'unknown',
        content: c.content ?? '',
        publishedAt: c.publishedDate ? String(c.publishedDate) : undefined,
        inReplyToId: c.parentCommentId ? String(c.parentCommentId) : undefined,
      })),
    isDraft: false,
  };
}

function fromAdoStatus(s?: CommentThreadStatus): ThreadStatus {
  switch (s) {
    case CommentThreadStatus.Fixed:
      return 'fixed';
    case CommentThreadStatus.WontFix:
      return 'wontFix';
    case CommentThreadStatus.Closed:
      return 'closed';
    case CommentThreadStatus.ByDesign:
      return 'byDesign';
    case CommentThreadStatus.Pending:
      return 'pending';
    default:
      return 'active';
  }
}

function toAdoStatus(s: ThreadStatus): CommentThreadStatus {
  switch (s) {
    case 'fixed':
      return CommentThreadStatus.Fixed;
    case 'wontFix':
      return CommentThreadStatus.WontFix;
    case 'closed':
      return CommentThreadStatus.Closed;
    case 'byDesign':
      return CommentThreadStatus.ByDesign;
    case 'pending':
      return CommentThreadStatus.Pending;
    default:
      return CommentThreadStatus.Active;
  }
}

function mapStatus(ct?: VersionControlChangeType): FileStatus {
  const v = ct ?? 0;
  if (v & VersionControlChangeType.Delete) {
    return 'deleted';
  }
  if (v & VersionControlChangeType.Rename) {
    return 'renamed';
  }
  if (v & VersionControlChangeType.Add) {
    return 'added';
  }
  return 'modified';
}

function shortBranch(ref?: string): string {
  return (ref ?? '').replace('refs/heads/', '');
}

function stripLead(path: string): string {
  return path.replace(/^\/+/, '');
}

function ensureLead(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function webUrl(cfg: AdoConfig, repo?: string, prId?: number): string {
  if (!repo || !prId) {
    return '';
  }
  return `${cfg.orgUrl}/${encodeURIComponent(cfg.project)}/_git/${encodeURIComponent(
    repo
  )}/pullrequest/${prId}`;
}
