import { AuthProvider } from '../infra/ado/authProvider';
import { createAdoClient } from '../infra/ado/clientFactory';
import { PullRequestSummary } from '../domain/models';

/** Use-case layer: list active PRs for the configured org/project. */
export class PullRequestService {
  constructor(private readonly auth: AuthProvider) {}

  async listActive(): Promise<PullRequestSummary[]> {
    const client = await createAdoClient(this.auth);
    return client.listActivePullRequests();
  }

  /** Active PR whose source branch is `branch`, for inline review of the open branch. */
  async findByBranch(branch: string): Promise<PullRequestSummary | undefined> {
    const client = await createAdoClient(this.auth);
    return client.findActivePrBySourceBranch(branch);
  }
}
