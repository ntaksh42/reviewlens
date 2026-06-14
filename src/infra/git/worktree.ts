import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const run = promisify(exec);

/** A detached worktree checked out at a PR's head commit. */
export interface Worktree {
  /** The source local clone the worktree was created from. */
  repoPath: string;
  /** Absolute path of the detached worktree at headSha. */
  worktreePath: string;
  headSha: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const quoted = args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  const { stdout } = await run(`git ${quoted}`, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Finds the local clone that corresponds to an ADO repo. Prefers an explicit
 * configured path; otherwise matches the PR's remote URL against the `origin`
 * of each candidate folder. Returns undefined if nothing matches.
 */
export async function resolveLocalRepo(
  remoteUrl: string,
  candidateFolders: string[],
  configuredPath: string | undefined
): Promise<string | undefined> {
  if (configuredPath && (await isGitRepo(configuredPath))) {
    return configuredPath;
  }
  const want = normalizeRemote(remoteUrl);
  for (const folder of candidateFolders) {
    const root = await repoRoot(folder);
    if (!root) {
      continue;
    }
    try {
      const origin = await git(root, ['remote', 'get-url', 'origin']);
      if (want && normalizeRemote(origin) === want) {
        return root;
      }
    } catch {
      // no origin remote; skip
    }
  }
  return undefined;
}

/**
 * Ensures a detached worktree at `headSha` exists under `cacheRoot`, fetching the
 * commit first if the local clone does not have it. Reused across iterations when
 * the head commit is unchanged.
 */
export async function ensureWorktree(
  repoPath: string,
  headSha: string,
  cacheRoot: string
): Promise<Worktree> {
  await ensureCommit(repoPath, headSha);

  const repoName = path.basename(repoPath);
  const worktreePath = path.join(cacheRoot, `${sanitize(repoName)}-${headSha.slice(0, 12)}`);

  if (await isGitRepo(worktreePath)) {
    return { repoPath, worktreePath, headSha };
  }

  await fs.promises.mkdir(cacheRoot, { recursive: true });
  // Detached so we never move the user's branch or touch their working tree.
  await git(repoPath, ['worktree', 'add', '--detach', worktreePath, headSha]);
  return { repoPath, worktreePath, headSha };
}

/** Best-effort removal of a worktree created by ensureWorktree. */
export async function removeWorktree(wt: Worktree): Promise<void> {
  try {
    await git(wt.repoPath, ['worktree', 'remove', '--force', wt.worktreePath]);
  } catch {
    // The worktree may already be gone; prune dangling administrative entries.
    try {
      await git(wt.repoPath, ['worktree', 'prune']);
    } catch {
      // ignore
    }
  }
}

async function ensureCommit(repoPath: string, sha: string): Promise<void> {
  if (await hasCommit(repoPath, sha)) {
    return;
  }
  // Try a targeted fetch first (cheap), then fall back to a full fetch for
  // servers that reject fetching an arbitrary SHA directly.
  try {
    await git(repoPath, ['fetch', 'origin', sha]);
  } catch {
    await git(repoPath, ['fetch', '--all', '--prune']);
  }
  if (!(await hasCommit(repoPath, sha))) {
    throw new Error(`commit ${sha.slice(0, 12)} not found in ${repoPath} after fetch`);
  }
}

async function hasCommit(repoPath: string, sha: string): Promise<boolean> {
  try {
    await git(repoPath, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function repoRoot(folder: string): Promise<string | undefined> {
  try {
    return await git(folder, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
}

async function isGitRepo(p: string): Promise<boolean> {
  try {
    await git(p, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** Normalize a clone URL so https/ssh/with-or-without-.git forms compare equal. */
function normalizeRemote(url: string): string {
  let s = url.trim().toLowerCase();
  s = s.replace(/\.git$/, '');
  s = s.replace(/^[a-z]+:\/\//, ''); // strip scheme
  s = s.replace(/^[^@/]+@/, ''); // strip user@
  s = s.replace(/:/g, '/'); // ssh host:path -> host/path
  s = s.replace(/\/+$/, '');
  return s;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
