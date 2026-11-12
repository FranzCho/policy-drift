import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listRoot, readText, resolveRoots } from '../src/files.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pd-files-'));
const put = (dir: string, file: string, content = 'x') => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
};
const SKIPPED = ['node_modules/a.js', 'dist/a.js', 'build/a.js', '.next/a.js', '.worktrees/a.js',
  '.claude/settings.local.json', '.cursor/a.json', '.vscode/a.json', '.idea/a.xml', '.github/workflows/a.yml'];

describe('listRoot', () => {
  it('walks a plain folder, sorted, without excluded folders or files over 1MB', () => {
    const dir = tmp();
    put(dir, 'src/b.ts');
    put(dir, 'src/a.ts');
    put(dir, 'z.md');
    put(dir, 'big.txt', 'x'.repeat(1024 * 1024 + 1));
    SKIPPED.forEach((f) => put(dir, f));
    expect(listRoot('r', dir)).toEqual({ label: 'r', dir, files: ['src/a.ts', 'src/b.ts', 'z.md'] });
  });

  it('uses git ls-files in a git repo: honors .gitignore, still drops excluded folders', () => {
    const dir = tmp();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    put(dir, '.gitignore', 'secret.txt\n');
    put(dir, 'secret.txt');
    put(dir, 'src/한글.ts');
    put(dir, 'src/a.ts');
    put(dir, 'node_modules/a.js');
    put(dir, 'dist/a.js');
    expect(listRoot('r', dir).files).toEqual(['.gitignore', 'src/a.ts', 'src/한글.ts']);
  });

  it('honors .gitignore when the root is a subfolder of a git repo (item 9)', () => {
    const dir = tmp();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    put(dir, '.gitignore', 'secret.txt\n/sub/gen/\n');
    put(dir, 'sub/secret.txt');
    put(dir, 'sub/gen/out.js');
    put(dir, 'sub/a.ts');
    put(dir, 'other/b.ts');
    expect(listRoot('sub', join(dir, 'sub')).files).toEqual(['a.ts']);
  });

  it.skipIf(process.getuid?.() === 0)('skips unreadable folders and files instead of failing (item 17)', () => {
    const dir = tmp();
    put(dir, 'a.ts');
    put(dir, 'locked/b.ts');
    put(dir, 'c.ts');
    chmodSync(join(dir, 'locked'), 0o000);
    chmodSync(join(dir, 'c.ts'), 0o000);
    try {
      expect(listRoot('r', dir).files).toEqual(['a.ts']);
    } finally {
      chmodSync(join(dir, 'locked'), 0o755);
    }
  });

  it('throws "root not found" for a missing dir', () => {
    const missing = join(tmp(), 'nope');
    expect(() => listRoot('x', missing)).toThrow(`root not found: ${missing}`);
  });
});

describe('resolveRoots', () => {
  it('defaults to the cwd when there is no config', () => {
    const dir = tmp();
    put(dir, 'a.ts');
    expect(resolveRoots(null, dir)).toEqual([{ label: '.', dir, files: ['a.ts'] }]);
  });

  it('keeps the config path as label and resolves it against cwd', () => {
    const dir = tmp();
    put(dir, 'sub/a.ts');
    const config = { language: 'ko' as const, jurisdictions: ['kr'], roots: [{ path: 'sub' }], policies: [] };
    expect(resolveRoots(config, dir)).toEqual([{ label: 'sub', dir: join(dir, 'sub'), files: ['a.ts'] }]);
  });

  it('names the missing root path', () => {
    const dir = tmp();
    const config = { language: 'ko' as const, jurisdictions: ['kr'], roots: [{ path: '../gone' }], policies: [] };
    expect(() => resolveRoots(config, dir)).toThrow(/root not found: .*gone/);
  });
});

describe('readText', () => {
  it('reads a listed file as utf8', () => {
    const dir = tmp();
    put(dir, 'a/b.txt', '안녕');
    expect(readText(listRoot('r', dir), 'a/b.txt')).toBe('안녕');
  });
});
