import { AdoClient } from './adoClient';
import { AuthProvider } from './authProvider';
import { getAdoConfig, isConfigured } from '../config';
import { NotConfiguredError, NotSignedInError } from '../../domain/errors';

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
  return new AdoClient(config, pat);
}
