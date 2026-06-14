import * as azdev from 'azure-devops-node-api';
import {
  GitPullRequestSearchCriteria,
  GitVersionType,
  PullRequestStatus,
  VersionControlChangeType,
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AdoConfig } from '../config';
import { ChangedFile, PullRequestSummary, ReviewData } from '../../domain/models';
import { FileStatus } from '../../domain/types';

/**
 * Thin wrapper over azure-devops-node-api. All ADO REST access goes through here
 * (SPEC §7.3).
 */
export class AdoClient {
  private readonly connection: azdev.WebApi;

  constructor(private readonly config: AdoConfig, pat: string) {
    const handler = azdev.getPersonalAccessTokenHandler(pat);
    this.connection = new azdev.WebApi(config.orgUrl, handler);
  }

  async listActivePullRequests(): Promise<PullRequestSummary[]> {
    const git = await this.connection.getGitApi();
    const criteria: GitPullRequestSearchCriteria = {
      status: PullRequestStatus.Active,
    };

    const prs = this.config.repository
      ? await git.getPullRequests(this.config.repository, criteria, this.config.project)
      : await git.getPullRequestsByProject(this.config.project, criteria);

    return (prs ?? []).map((pr) => ({
      id: pr.pullRequestId ?? 0,
      title: pr.title ?? '(no title)',
      author: pr.createdBy?.displayName ?? 'unknown',
      repository: pr.repository?.name ?? '',
      repositoryId: pr.repository?.id ?? '',
      sourceBranch: shortBranch(pr.sourceRefName),
      targetBranch: shortBranch(pr.targetRefName),
      url: webUrl(this.config, pr.repository?.name, pr.pullRequestId),
    }));
  }

  /** Changed files + base/head commits for the latest PR iteration (M1a). */
  async getReview(prId: number, repositoryId: string): Promise<ReviewData> {
    const git = await this.connection.getGitApi();
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
    const git = await this.connection.getGitApi();
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
