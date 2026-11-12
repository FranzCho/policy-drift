import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config, ScanRoot } from './types.js';

// Tool and editor config folders too: a .claude/settings.local.json is not app code.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.worktrees', '.claude', '.cursor', '.vscode', '.idea', '.github']);
const MAX_BYTES = 1024 * 1024;

const usable = (dir: string, file: string): boolean => {
  if (file.split('/').some((part) => SKIP_DIRS.has(part))) return false;
  try {
    const s = statSync(join(dir, file)); // also drops files git lists but that were deleted
    if (!s.isFile() || s.size > MAX_BYTES) return false;
    accessSync(join(dir, file), constants.R_OK); // unreadable (EACCES/EPERM): skip, not fatal
    return true;
  } catch {
    return false;
  }
};

export function isGitRepo(dir: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').trim() === 'true';
  } catch {
    return false;
  }
}

function walk(dir: string, prefix = ''): string[] {
  let entries;
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (prefix && (code === 'EACCES' || code === 'EPERM')) return []; // unreadable folder: skip
    throw e;
  }
  return entries.flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, rel) : e.isFile() ? [rel] : []; // symlinks skipped
  });
}

export function listRoot(label: string, dir: string): ScanRoot {
  if (!existsSync(dir)) throw new Error(`root not found: ${dir}`);
  // Also for a subfolder of a repo: ls-files run from `dir` lists paths relative to it and honors every .gitignore above.
  const all = isGitRepo(dir)
    ? execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString('utf8').split('\0').filter(Boolean)
    : walk(dir);
  return { label, dir, files: all.filter((f) => usable(dir, f)).sort() };
}

export function resolveRoots(config: Config | null, cwd: string): ScanRoot[] {
  const roots = config?.roots ?? [{ path: '.' }];
  return roots.map((r) => listRoot(r.path, resolve(cwd, r.path)));
}

export function readText(root: ScanRoot, file: string): string {
  return readFileSync(join(root.dir, file), 'utf8');
}
