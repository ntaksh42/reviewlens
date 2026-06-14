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
}
