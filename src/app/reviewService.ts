import { AuthProvider } from '../infra/ado/authProvider';
import { AdoClient, CommentTarget } from '../infra/ado/adoClient';
import { createAdoClient } from '../infra/ado/clientFactory';
import {
  ChangedFile,
  PullRequestOverview,
  PullRequestSummary,
  ReviewData,
  Thread,
} from '../domain/models';
import { PrVote, Side } from '../domain/types';
import { threadsSignature } from '../domain/suggestion';

interface ActiveReview {
  pr: PullRequestSummary;
  client: AdoClient;
  data: ReviewData;
  overview: PullRequestOverview;
  threads: Thread[];
  /** File text keyed by `${commit}:${path}`. Content at a commit is immutable. */
  contentCache: Map<string, Promise<string>>;
  /** Absolute path of the local worktree at head, when local review is enabled. */
  localPath?: string;
  /** Lowercased changed-file paths, for gating comments on the local checkout. */
  changedPaths: Set<string>;
}

/** Holds the PR currently under review and serves its files + comment threads. */
export class ReviewService {
  private active: ActiveReview | undefined;

  constructor(private readonly auth: AuthProvider) {}

  get current(): ActiveReview | undefined {
    return this.active;
  }

  /** Id of the PR under review, or undefined when none is open. */
  get currentPrId(): number | undefined {
    return this.active?.pr.id;
  }

  /** Active PR whose source branch is `branch`, for inline review of the open branch. */
  async findByBranch(branch: string): Promise<PullRequestSummary | undefined> {
    const client = await createAdoClient(this.auth);
    return client.findActivePrBySourceBranch(branch);
  }

  async open(pr: PullRequestSummary): Promise<ReviewData> {
    const client = await createAdoClient(this.auth);
    // The review (files + commits), the overview (description/reviewers/work
    // items), and the comment threads are independent fetches; run them
    // concurrently instead of one after the other.
    const [data, overview, threads] = await Promise.all([
      client.getReview(pr.id, pr.repositoryId),
      client.getOverview(pr.id, pr.repositoryId),
      client.getThreads(pr.id, pr.repositoryId),
    ]);
    this.active = {
      pr,
      client,
      data,
      overview,
      threads,
      contentCache: new Map(),
      changedPaths: new Set(data.files.map((f) => f.path.toLowerCase())),
    };
    return data;
  }

  /** The open PR's overview (description, reviewers, work items). */
  get overview(): PullRequestOverview | undefined {
    return this.active?.overview;
  }

  /** Absolute path of the local worktree at head, when local review is on. */
  get localPath(): string | undefined {
    return this.active?.localPath;
  }

  setLocalPath(path: string | undefined): void {
    if (this.active) {
      this.active.localPath = path;
    }
  }

  /** Whether a repo-relative path is one of the PR's changed files. */
  isChangedFile(path: string): boolean {
    return this.active?.changedPaths.has(path.toLowerCase()) ?? false;
  }

  /** The changed-file entry for a repo-relative path, if the PR touched it. */
  changedFile(path: string): ChangedFile | undefined {
    const want = path.toLowerCase();
    return this.active?.data.files.find((f) => f.path.toLowerCase() === want);
  }

  async fileContent(side: Side, file: ChangedFile): Promise<string> {
    if (!this.active) {
      return '';
    }
    const { client, data, contentCache } = this.active;
    const commit = side === 'left' ? data.baseCommit : data.headCommit;
    if (!commit) {
      return '';
    }
    // Cache the in-flight promise so repeated opens of a file (next/prev
    // navigation, switching back) reuse one fetch instead of round-tripping.
    const key = `${commit}:${file.path}`;
    let pending = contentCache.get(key);
    if (!pending) {
      pending = client.getFileContent(data.repositoryId, file.path, commit);
      contentCache.set(key, pending);
    }
    return pending;
  }

  threadsForFile(path: string): Thread[] {
    return this.active?.threads.filter((t) => t.anchor?.filePath === path) ?? [];
  }

  /** All comment threads on the open PR (for navigation/search). */
  get threads(): Thread[] {
    return this.active?.threads ?? [];
  }

  /** Create a comment and return the new ADO thread id (for anchor snapshots). */
  async createComment(
    filePath: string,
    target: CommentTarget,
    text: string
  ): Promise<number | undefined> {
    if (!this.active) {
      return undefined;
    }
    const { client, pr, data } = this.active;
    const threadId = await client.createComment(pr.id, data.repositoryId, filePath, target, text);
    await this.refreshThreads();
    return threadId;
  }

  async reply(threadId: number, text: string): Promise<void> {
    if (!this.active) {
      return;
    }
    const { client, pr, data } = this.active;
    await client.replyToThread(pr.id, data.repositoryId, threadId, text);
    await this.refreshThreads();
  }

  async resolve(threadId: number): Promise<void> {
    if (!this.active) {
      return;
    }
    const { client, pr, data } = this.active;
    await client.setThreadStatus(pr.id, data.repositoryId, threadId, 'closed');
    await this.refreshThreads();
  }

  /** Cast the signed-in reviewer's vote on the open PR (FR-20). */
  async vote(vote: PrVote): Promise<void> {
    if (!this.active) {
      return;
    }
    const { client, pr, data } = this.active;
    await client.setVote(pr.id, data.repositoryId, vote);
  }

  /** Complete (merge) the open PR (FR-21). */
  async completePr(): Promise<void> {
    if (!this.active) {
      return;
    }
    const { client, pr, data } = this.active;
    if (!data.headCommit) {
      throw new Error('the PR head commit is unknown.');
    }
    await client.completePullRequest(pr.id, data.repositoryId, data.headCommit);
  }

  /** Abandon the open PR (FR-21). */
  async abandonPr(): Promise<void> {
    if (!this.active) {
      return;
    }
    const { client, pr, data } = this.active;
    await client.abandonPullRequest(pr.id, data.repositoryId);
  }

  /**
   * Re-fetch the open PR's threads from ADO (used by both mutating operations
   * and the background sync). Returns whether the threads changed since the last
   * fetch, so callers can skip a re-render when nothing moved.
   */
  async syncThreads(): Promise<boolean> {
    const before = threadsSignature(this.threads);
    await this.refreshThreads();
    return threadsSignature(this.threads) !== before;
  }

  private async refreshThreads(): Promise<void> {
    if (!this.active) {
      return;
    }
    const { client, pr } = this.active;
    this.active.threads = await client.getThreads(pr.id, pr.repositoryId);
  }
}
