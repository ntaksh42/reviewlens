import { AuthProvider } from '../infra/ado/authProvider';
import { AdoClient, CommentTarget } from '../infra/ado/adoClient';
import { createAdoClient } from '../infra/ado/clientFactory';
import { ChangedFile, PullRequestSummary, ReviewData, Thread } from '../domain/models';
import { Side } from '../domain/types';

interface ActiveReview {
  pr: PullRequestSummary;
  client: AdoClient;
  data: ReviewData;
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

  async open(pr: PullRequestSummary): Promise<ReviewData> {
    const client = await createAdoClient(this.auth);
    // The review (files + commits) and the comment threads are independent
    // fetches; run them concurrently instead of one after the other.
    const [data, threads] = await Promise.all([
      client.getReview(pr.id, pr.repositoryId),
      client.getThreads(pr.id, pr.repositoryId),
    ]);
    this.active = {
      pr,
      client,
      data,
      threads,
      contentCache: new Map(),
      changedPaths: new Set(data.files.map((f) => f.path.toLowerCase())),
    };
    return data;
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

  async createComment(filePath: string, target: CommentTarget, text: string): Promise<void> {
    if (!this.active) {
      return;
    }
    const { client, pr, data } = this.active;
    await client.createComment(pr.id, data.repositoryId, filePath, target, text);
    await this.refreshThreads();
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

  private async refreshThreads(): Promise<void> {
    if (!this.active) {
      return;
    }
    const { client, pr } = this.active;
    this.active.threads = await client.getThreads(pr.id, pr.repositoryId);
  }
}
