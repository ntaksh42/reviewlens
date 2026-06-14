import { exec } from 'child_process';
import { promisify } from 'util';

const run = promisify(exec);

async function git(cwd: string, args: string[]): Promise<string> {
  const quoted = args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  const { stdout } = await run(`git ${quoted}`, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Absolute toplevel of the git repo containing `folder`, or undefined. */
export async function repoRoot(folder: string): Promise<string | undefined> {
  try {
    return await git(folder, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
}

/**
 * Current branch name of the git repo at `folder` (its working tree's checked-out
 * branch), or undefined when the folder is not a repo or is in detached HEAD.
 * Used to match the open workspace branch against a PR's source branch.
 */
export async function getCurrentBranch(folder: string): Promise<string | undefined> {
  const root = await repoRoot(folder);
  if (!root) {
    return undefined;
  }
  try {
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}
