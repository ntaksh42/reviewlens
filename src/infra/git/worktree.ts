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

  const wt: Worktree = { repoPath, worktreePath, headSha };
  if (await isGitRepo(worktreePath)) {
    await recordUse(cacheRoot, wt);
    return wt;
  }

  await fs.promises.mkdir(cacheRoot, { recursive: true });
  // Detached so we never move the user's branch or touch their working tree.
  await git(repoPath, ['worktree', 'add', '--detach', worktreePath, headSha]);
  await recordUse(cacheRoot, wt);
  return wt;
}

/**
 * Removes least-recently-used cached worktrees beyond `keep`, never touching any
 * path in `exclude` (e.g. the one in use). Worktrees are otherwise kept forever,
 * so this bounds disk growth across many reviewed PRs.
 */
export async function pruneWorktrees(
  cacheRoot: string,
  keep: number,
  exclude: string[] = []
): Promise<void> {
  const ex = new Set(exclude);
  const entries = await readManifest(cacheRoot);
  const prunable = entries
    .filter((e) => !ex.has(e.worktreePath))
    .sort((a, b) => b.lastUsedMs - a.lastUsedMs);

  const removed = new Set<string>();
  for (const e of prunable.slice(Math.max(0, keep))) {
    await removeWorktree({ repoPath: e.repoPath, worktreePath: e.worktreePath, headSha: e.headSha });
    removed.add(e.worktreePath);
  }
  if (removed.size > 0) {
    await writeManifest(
      cacheRoot,
      entries.filter((e) => !removed.has(e.worktreePath))
    );
  }
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

/** Tracks created worktrees so the cache can be pruned LRU-style across sessions. */
interface ManifestEntry {
  worktreePath: string;
  repoPath: string;
  headSha: string;
  lastUsedMs: number;
}

function manifestPath(cacheRoot: string): string {
  return path.join(cacheRoot, 'manifest.json');
}

async function readManifest(cacheRoot: string): Promise<ManifestEntry[]> {
  try {
    const raw = await fs.promises.readFile(manifestPath(cacheRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeManifest(cacheRoot: string, entries: ManifestEntry[]): Promise<void> {
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  await fs.promises.writeFile(manifestPath(cacheRoot), JSON.stringify(entries, null, 2));
}

async function recordUse(cacheRoot: string, wt: Worktree): Promise<void> {
  const entries = (await readManifest(cacheRoot)).filter(
    (e) => e.worktreePath !== wt.worktreePath
  );
  entries.push({
    worktreePath: wt.worktreePath,
    repoPath: wt.repoPath,
    headSha: wt.headSha,
    lastUsedMs: Date.now(),
  });
  await writeManifest(cacheRoot, entries);
}
