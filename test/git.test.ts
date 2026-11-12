import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diffAgainst, extractTree, isGitRepo, mergeBase } from '../src/git.js';

const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pd-git-'));
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString().trim();
const put = (dir: string, file: string, content: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
};
function repo() {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'src/a.ts', 'export const retries = 3;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('isGitRepo', () => {
  it('true for a repo, false for a plain folder', () => {
    expect(isGitRepo(repo())).toBe(true);
    expect(isGitRepo(tmp())).toBe(false);
  });
  it('false for a folder that does not exist', () => {
    expect(isGitRepo(join(tmp(), 'nope'))).toBe(false);
  });
});

describe('mergeBase', () => {
  it('returns the fork point, not the base tip', () => {
    const dir = repo();
    const fork = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feature');
    put(dir, 'f.txt', 'f');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'f');
    git(dir, 'checkout', '-q', 'main');
    put(dir, 'm.txt', 'm');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'm');
    git(dir, 'checkout', '-q', 'feature');
    expect(mergeBase(dir, 'main')).toBe(fork);
  });
  it('falls back to origin/<branch>', () => {
    const dir = repo();
    git(dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    expect(mergeBase(dir, 'develop')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });
  it('null when the branch is missing, an option-like name, or not a repo', () => {
    expect(mergeBase(repo(), 'nope')).toBeNull();
    expect(mergeBase(repo(), '--all')).toBeNull();
    expect(mergeBase(tmp(), 'main')).toBeNull();
  });
});

describe('extractTree', () => {
  it('unpacks the tree at ref into a temp folder, ignoring the working copy', () => {
    const dir = repo();
    const ref = git(dir, 'rev-parse', 'HEAD');
    put(dir, 'src/a.ts', 'export const retries = 9;\n');
    put(dir, 'untracked.txt', 'u');
    const out = extractTree(dir, ref);
    made.push(out);
    expect(out.startsWith(tmpdir()) || out.includes('policy-drift-')).toBe(true);
    expect(readFileSync(join(out, 'src/a.ts'), 'utf8')).toBe('export const retries = 3;\n');
    expect(existsSync(join(out, 'untracked.txt'))).toBe(false);
  });
});

describe('diffAgainst', () => {
  it('shows uncommitted changes with zero context', () => {
    const dir = repo();
    const ref = git(dir, 'rev-parse', 'HEAD');
    put(dir, 'src/a.ts', 'export const retries = 5;\n');
    const diff = diffAgainst(dir, ref);
    expect(diff).toContain('+++ b/src/a.ts');
    expect(diff).toContain('-export const retries = 3;');
    expect(diff).toContain('+export const retries = 5;');
    expect(diff).toContain('@@ -1 +1 @@');
  });
  it('is empty when nothing changed', () => {
    const dir = repo();
    expect(diffAgainst(dir, git(dir, 'rev-parse', 'HEAD'))).toBe('');
  });
  it('ignores user diff config (noprefix, mnemonicPrefix, quotepath) and keeps non-ASCII paths (item 6)', () => {
    const dir = repo();
    put(dir, 'src/결제.ts', 'export const retries = 3;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'k');
    const ref = git(dir, 'rev-parse', 'HEAD');
    for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['core.quotepath', 'true'], ['diff.renames', 'copies'], ['color.diff', 'always']]) git(dir, 'config', k, v);
    put(dir, 'src/결제.ts', 'export const retries = 5;\n');
    const diff = diffAgainst(dir, ref);
    expect(diff).toContain('+++ b/src/결제.ts');
    expect(diff).not.toContain('\x1b[');
  });
});
