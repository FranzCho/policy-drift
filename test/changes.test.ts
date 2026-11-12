import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Config, DataMap, ScanRoot, Vendor } from '../src/types.js';
import { diffDataMaps, scanChanges } from '../src/changes.js';

// Tiny fake: a root "uses openai" when its package.json mentions "openai".
vi.mock('../src/scan.js', () => ({
  scanDataMap: (roots: ScanRoot[]): DataMap => {
    const evidence = roots.flatMap((r) => {
      if (!r.files.includes('package.json')) return [];
      const text = readFileSync(join(r.dir, 'package.json'), 'utf8');
      return text.includes('"openai"') ? [{ root: r.label, file: 'package.json', line: 1 }] : [];
    });
    return { vendors: evidence.length ? [{ vendorId: 'openai', via: 'dependency', evidence }] : [], piiFields: [], features: [] };
  },
}));

const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pd-changes-'));
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
const commit = (dir: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c');
};
function repo(files: Record<string, string>, branch = 'main') {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', branch);
  Object.entries(files).forEach(([f, c]) => put(dir, f, c));
  commit(dir);
  return dir;
}
const PKG = '{"dependencies":{"openai":"^4.0.0"}}\n';
const vendors: Vendor[] = [];
const cfg = (roots: Config['roots']): Config => ({ language: 'ko', jurisdictions: ['kr'], roots, policies: [] });
const empty = { vendors: [], piiFields: [], features: [] };

describe('scanChanges', () => {
  it('reports a numeric rule change that is not committed', async () => {
    const dir = repo({ 'src/pay.ts': 'export const MAX_RETRY = 3;\n' });
    git(dir, 'checkout', '-q', '-b', 'feature');
    put(dir, 'src/pay.ts', 'export const MAX_RETRY = 5;\n');
    const c = await scanChanges(null, dir, vendors);
    expect(c.ruleCandidates).toEqual([
      { root: '.', file: 'src/pay.ts', line: 1, before: '3', after: '5', keyword: 'pay', text: 'export const MAX_RETRY = 5;' },
    ]);
    expect(c.skipped).toEqual([]);
  });

  it('ignores number changes without a keyword', async () => {
    const dir = repo({ 'src/net.ts': 'export const TIMEOUT = 3;\n' });
    put(dir, 'src/net.ts', 'export const TIMEOUT = 5;\n');
    expect((await scanChanges(null, dir, vendors)).ruleCandidates).toEqual([]);
  });

  it('puts a removed dependency in removed.vendors, with evidence from the base tree', async () => {
    const dir = repo({ 'package.json': PKG });
    git(dir, 'checkout', '-q', '-b', 'feature');
    put(dir, 'package.json', '{"dependencies":{}}\n');
    commit(dir);
    const c = await scanChanges(null, dir, vendors);
    expect(c.removed.vendors).toMatchObject([{ vendorId: 'openai', evidence: [{ root: '.', file: 'package.json' }] }]);
    expect(c.added.vendors).toEqual([]);
  });

  it('puts an uncommitted added dependency in added.vendors', async () => {
    const dir = repo({ 'package.json': '{"dependencies":{}}\n' });
    put(dir, 'package.json', PKG);
    const c = await scanChanges(null, dir, vendors);
    expect(c.added.vendors.map((v) => v.vendorId)).toEqual(['openai']);
    expect(c.removed.vendors).toEqual([]);
  });

  it('includes untracked new files in "now"', async () => {
    const dir = repo({ 'README.txt': 'x' });
    put(dir, 'package.json', PKG);
    const c = await scanChanges(null, dir, vendors);
    expect(c.added.vendors).toMatchObject([{ vendorId: 'openai' }]);
  });

  it('compares against the merge-base, not the base tip', async () => {
    const dir = repo({ 'src/pay.ts': 'export const MAX_RETRY = 3;\n' });
    git(dir, 'checkout', '-q', '-b', 'feature');
    put(dir, 'x.txt', 'x');
    commit(dir);
    git(dir, 'checkout', '-q', 'main');
    put(dir, 'src/pay.ts', 'export const MAX_RETRY = 7;\n');
    commit(dir);
    git(dir, 'checkout', '-q', 'feature');
    const c = await scanChanges(null, dir, vendors, 'main');
    expect(c).toEqual({ added: empty, removed: empty, ruleCandidates: [], skipped: [], notes: [] });
  });

  it('returns an empty result when only CSS changed', async () => {
    const dir = repo({ 'a.css': 'a { margin: 3px; }\n', 'package.json': PKG });
    put(dir, 'a.css', 'a { margin: 5px; }\n');
    expect(await scanChanges(null, dir, vendors, 'main')).toEqual({ added: empty, removed: empty, ruleCandidates: [], skipped: [], notes: [] });
  });

  it('adds a note when the base branch is HEAD itself, and still compares the working tree (item 5b)', async () => {
    const dir = repo({ 'src/pay.ts': 'export const MAX_RETRY = 3;\n' });
    put(dir, 'src/pay.ts', 'export const MAX_RETRY = 5;\n');
    const c = await scanChanges(null, dir, vendors);
    expect(c.ruleCandidates).toHaveLength(1);
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0]).toMatch(/^\.: .*"main".*committed.*cannot be seen.*tag or commit/);
    expect((await scanChanges(null, dir, vendors, 'main')).notes).toEqual([]); // an explicit base suppresses the note
  });

  it('falls back to origin/<base> when the local base branch is HEAD (item 5b)', async () => {
    const dir = repo({ 'src/pay.ts': 'export const MAX_RETRY = 3;\n' });
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    put(dir, 'src/pay.ts', 'export const MAX_RETRY = 4;\n');
    commit(dir); // local main moved ahead of origin/main
    const c = await scanChanges(null, dir, vendors);
    expect(c.notes).toEqual([]);
    expect(c.ruleCandidates.map((x) => [x.before, x.after])).toEqual([['3', '4']]);
  });

  it('skips a root that is not a git repository', async () => {
    const dir = tmp();
    put(dir, 'plain/package.json', PKG);
    const c = await scanChanges(cfg([{ path: 'plain' }]), dir, vendors);
    expect(c.skipped).toEqual([{ root: 'plain', reason: 'not a git repository' }]);
    expect(c.added).toEqual(empty);
  });

  it('skips a root whose base branch does not exist (argument and config)', async () => {
    const dir = repo({ 'a.txt': 'x' });
    expect((await scanChanges(null, dir, vendors, 'nope')).skipped).toEqual([{ root: '.', reason: 'base branch not found: nope' }]);
    expect((await scanChanges(cfg([{ path: '.', baseBranch: 'gone' }]), dir, vendors)).skipped).toEqual([
      { root: '.', reason: 'base branch not found: gone' },
    ]);
  });

  it('the base argument wins over the root baseBranch', async () => {
    const dir = repo({ 'a.txt': 'x' });
    const c = await scanChanges(cfg([{ path: '.', baseBranch: 'gone' }]), dir, vendors, 'main');
    expect(c.skipped).toEqual([]);
  });

  it('tries main, develop, master when no base is given', async () => {
    const dir = repo({ 'src/pay.ts': 'export const MAX_RETRY = 3;\n' }, 'develop');
    put(dir, 'src/pay.ts', 'export const MAX_RETRY = 4;\n');
    const c = await scanChanges(null, dir, vendors);
    expect(c.skipped).toEqual([]);
    expect(c.ruleCandidates).toHaveLength(1);
    const none = repo({ 'a.txt': 'x' }, 'trunk');
    expect((await scanChanges(null, none, vendors)).skipped).toHaveLength(1);
  });

  it('keeps going past a skipped root and handles several roots', async () => {
    const root = tmp();
    const a = join(root, 'a');
    mkdirSync(a);
    git(a, 'init', '-q', '-b', 'main');
    put(a, 'package.json', '{}\n');
    commit(a);
    put(a, 'package.json', PKG);
    put(root, 'b/x.txt', 'x');
    const c = await scanChanges(cfg([{ path: 'b' }, { path: 'a' }]), root, vendors);
    expect(c.skipped).toEqual([{ root: 'b', reason: 'not a git repository' }]);
    expect(c.added.vendors).toMatchObject([{ vendorId: 'openai', evidence: [{ root: 'a' }] }]);
  });

  it('throws a clear error for a root that does not exist', async () => {
    await expect(scanChanges(cfg([{ path: 'missing' }]), tmp(), vendors)).rejects.toThrow('root not found');
  });

  it('removes its temp folders', async () => {
    const t = tmp();
    const old = process.env.TMPDIR;
    process.env.TMPDIR = t;
    try {
      const dir = repo({ 'package.json': PKG });
      await scanChanges(null, dir, vendors);
      expect(readdirSync(t).filter((n) => n.startsWith('policy-drift-'))).toEqual([]);
    } finally {
      process.env.TMPDIR = old;
    }
  });
});

describe('diffDataMaps', () => {
  const ev = (file: string) => [{ root: 'r', file, line: 1 }];
  const feat = (name: string, file = 'routes') => ({ name, evidence: ev(file)[0] });
  const pii = (key: string, source: 'sql' | 'form', file = 'x') => ({ key, name: key, source, evidence: ev(file)[0] });
  const before: DataMap = {
    vendors: [{ vendorId: 'a', via: 'dependency', evidence: ev('old') }, { vendorId: 'b', via: 'host', evidence: ev('b') }],
    piiFields: [pii('email', 'sql'), pii('phone', 'sql')],
    features: [feat('login'), feat('old')],
  };
  const after: DataMap = {
    vendors: [{ vendorId: 'b', via: 'dependency', evidence: ev('new') }, { vendorId: 'c', via: 'host', evidence: ev('c') }],
    piiFields: [pii('email', 'sql', 'moved'), pii('email', 'form'), pii('birth', 'sql')],
    features: [feat('login', 'moved'), feat('new')],
  };

  it('keeps full objects from the side they exist on', () => {
    const d = diffDataMaps(before, after);
    expect(d.added.vendors.map((v) => v.vendorId)).toEqual(['c']);
    expect(d.removed.vendors).toEqual([before.vendors[0]]);
    expect(d.added.piiFields.map((p) => `${p.key}/${p.source}`)).toEqual(['email/form', 'birth/sql']);
    expect(d.removed.piiFields.map((p) => p.key)).toEqual(['phone']);
    expect(d.added.features.map((f) => f.name)).toEqual(['new']);
    expect(d.removed.features).toEqual([before.features[1]]);
  });

  it('is empty for identical maps', () => {
    expect(diffDataMaps(before, before)).toEqual({ added: empty, removed: empty });
  });
});
