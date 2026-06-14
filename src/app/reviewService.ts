import { AuthProvider } from '../infra/ado/authProvider';
import { AdoClient } from '../infra/ado/adoClient';
import { createAdoClient } from '../infra/ado/clientFactory';
import { ChangedFile, PullRequestSummary, ReviewData } from '../domain/models';
import { Side } from '../domain/types';

interface ActiveReview {
  pr: PullRequestSummary;
  client: AdoClient;
  data: ReviewData;
}

/** Holds the PR currently under review and serves its file contents (M1a). */
export class ReviewService {
  private active: ActiveReview | undefined;

  constructor(private readonly auth: AuthProvider) {}

  get current(): ActiveReview | undefined {
    return this.active;
  }

  async open(pr: PullRequestSummary): Promise<ReviewData> {
    const client = await createAdoClient(this.auth);
    const data = await client.getReview(pr.id, pr.repositoryId);
    this.active = { pr, client, data };
    return data;
  }

  async fileContent(side: Side, file: ChangedFile): Promise<string> {
    if (!this.active) {
      return '';
    }
    const { client, data } = this.active;
    const commit = side === 'left' ? data.baseCommit : data.headCommit;
    if (!commit) {
      return '';
    }
    return client.getFileContent(data.repositoryId, file.path, commit);
  }
}
