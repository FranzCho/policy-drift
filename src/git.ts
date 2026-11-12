import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX = 1024 * 1024 * 1024;
const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, maxBuffer: MAX, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');

export { isGitRepo } from './files.js';

export function headSha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

export function mergeBase(dir: string, baseBranch: string): string | null {
  if (baseBranch.startsWith('-')) return null; // never let a config value act as a git option
  for (const name of [baseBranch, `origin/${baseBranch}`]) {
    try {
      const sha = git(dir, ['merge-base', 'HEAD', name]).trim();
      if (sha) return sha;
    } catch {
      // try the next name
    }
  }
  return null;
}

// ponytail: 전체 트리를 푼다. 큰 repo 에서 느리면 필요한 확장자만 풀도록 바꾼다
export function extractTree(dir: string, ref: string): string {
  const out = mkdtempSync(join(tmpdir(), 'policy-drift-'));
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', ref], { cwd: dir, maxBuffer: MAX, stdio: ['ignore', 'pipe', 'ignore'] });
    execFileSync('tar', ['-x', '-C', out], { input: tar, stdio: ['pipe', 'ignore', 'ignore'] });
    return out;
  } catch (e) {
    rmSync(out, { recursive: true, force: true });
    throw e;
  }
}

// Working folder vs ref. Untracked files are not included. Paths are relative to `dir`.
// Prefixes, renames, colors and path quoting are pinned so the user's git config cannot change the format.
export function diffAgainst(dir: string, ref: string): string {
  return git(dir, ['-c', 'core.quotepath=false', 'diff', '-U0', '--src-prefix=a/', '--dst-prefix=b/', '--no-renames',
    '--no-ext-diff', '--no-color', '--relative', ref]);
}
