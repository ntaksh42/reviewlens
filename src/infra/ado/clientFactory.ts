import { createHash } from 'crypto';
import { AdoClient } from './adoClient';
import { AuthProvider } from './authProvider';
import { AdoConfig, getAdoConfig, isConfigured } from '../config';
import { NotConfiguredError, NotSignedInError } from '../../domain/errors';

/**
 * One cached client, reused while the config + PAT are unchanged. Each AdoClient
 * holds a WebApi connection whose first request does a resource-area lookup
 * round trip; rebuilding the client per action (list, open, every comment op)
 * pays that latency every time. Keying the cache on the inputs means a config or
 * token change transparently yields a fresh client.
 */
let cached: { key: string; client: AdoClient } | undefined;

/** Builds an AdoClient from current settings + stored PAT, or throws a typed error. */
export async function createAdoClient(auth: AuthProvider): Promise<AdoClient> {
  const config = getAdoConfig();
  if (!isConfigured(config)) {
    throw new NotConfiguredError('Set reviewlens.orgUrl and reviewlens.project in Settings.');
  }
  const pat = await auth.getPat();
  if (!pat) {
    throw new NotSignedInError('Run "ReviewLens: Sign in (PAT)" to add a token.');
  }
  const key = cacheKey(config, pat);
  if (cached?.key !== key) {
    cached = { key, client: new AdoClient(config, pat) };
  }
  return cached.client;
}

/** Drop the cached client (and the connection holding the PAT), e.g. on sign-out. */
export function clearAdoClientCache(): void {
  cached = undefined;
}

function cacheKey(config: AdoConfig, pat: string): string {
  // Hash the PAT rather than storing it verbatim, so the plaintext token isn't
  // duplicated into a long-lived module-level string.
  const patHash = createHash('sha256').update(pat).digest('hex');
  return JSON.stringify([config.orgUrl, config.project, config.repository, patHash]);
}
