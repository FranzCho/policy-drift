import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { DISCLAIMER } from '../src/format.js';
import { commitAll, git, PRIVACY_NO_OPENAI, put, tmp } from './helpers.js';

async function run(cwd: string, ...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, { cwd, stdout: { write: (s) => (stdout += s) }, stderr: { write: (s) => (stderr += s) } });
  return { code, stdout, stderr };
}

/** Git repo on main with no third-party services; the openai SDK is added afterwards without committing. */
function repoWithNewVendor(privacy = PRIVACY_NO_OPENAI) {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'package.json', '{"dependencies":{}}\n');
  put(dir, 'docs/privacy.md', privacy);
  put(dir, '.policy-drift.json', JSON.stringify({
    language: 'en', roots: [{ path: '.', baseBranch: 'main' }], policies: [{ type: 'privacy', source: 'file', path: 'docs/privacy.md' }],
  }));
  commitAll(dir);
  put(dir, 'package.json', '{"dependencies":{"openai":"^4"}}\n');
  return dir;
}

describe('audit', () => {
  it('prints the findings table and exits 0 even with findings', async () => {
    const r = await run(repoWithNewVendor(), 'audit');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Not mentioned');
    expect(r.stdout).toContain('OpenAI');
    expect(r.stdout).toContain('package.json:1');
    expect(r.stdout.trimEnd().endsWith(DISCLAIMER.en)).toBe(true);
  });
  it('--lang overrides the config language', async () => {
    const r = await run(repoWithNewVendor(), 'audit', '--lang', 'ko');
    expect(r.stdout).toContain('언급 없음');
    expect(r.stdout).toContain(DISCLAIMER.ko);
  });
  it('reports a document that cannot be read on stderr and keeps going', async () => {
    const dir = repoWithNewVendor();
    put(dir, '.policy-drift.json', JSON.stringify({ policies: [{ type: 'privacy', source: 'file', path: 'docs/gone.md' }] }));
    const r = await run(dir, 'audit');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('policy error (privacy, docs/gone.md): file not found: docs/gone.md');
    expect(r.stderr).toContain('no privacy document was loaded');
  });
  it('exits 2 with the init hint when there is no config', async () => {
    const r = await run(tmp(), 'audit');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('npx policy-drift init');
    expect(r.stdout).toBe('');
  });
  it('exits 2 with a one-line message for a missing root', async () => {
    const dir = repoWithNewVendor();
    put(dir, '.policy-drift.json', JSON.stringify({ roots: [{ path: 'nope' }], policies: [{ type: 'privacy', source: 'file', path: 'docs/privacy.md' }] }));
    const r = await run(dir, 'audit');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: root not found: .*nope\n$/);
  });
});

describe('audit --diff', () => {
  it('exits 1 when a newly added service is not mentioned in the privacy policy', async () => {
    const r = await run(repoWithNewVendor(), 'audit', '--diff');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('openai (dependency)');
    expect(r.stdout).toContain('Not mentioned');
  });
  it('exits 0 when the new service is mentioned', async () => {
    const r = await run(repoWithNewVendor(`${PRIVACY_NO_OPENAI}\nOpenAI 에 위탁합니다.\n`), 'audit', '--diff', 'main');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('openai (dependency)');
    expect(r.stdout).not.toContain('Not mentioned');
  });
  it('only counts services added since the base, not ones already in it', async () => {
    const dir = repoWithNewVendor();
    git(dir, 'switch', '-q', '-c', 'feature');
    commitAll(dir); // openai is now committed on feature; main still lacks it
    expect((await run(dir, 'audit', '--diff', 'main')).code).toBe(1);
    const same = await run(dir, 'audit', '--diff', 'feature'); // base = HEAD: nothing is new
    expect(same.code).toBe(0);
    expect(same.stdout).toContain('Nothing changed');
  });
  it('exits 2 (fail closed) when no privacy document could be loaded', async () => {
    const dir = repoWithNewVendor();
    put(dir, '.policy-drift.json', JSON.stringify({ roots: [{ path: '.', baseBranch: 'main' }], policies: [] }));
    const r = await run(dir, 'audit', '--diff');
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('openai (dependency)');
  });
});

describe('audit --diff limits (item 5)', () => {
  it('exits 2 after printing the reasons when a root was skipped', async () => {
    const dir = repoWithNewVendor();
    const plain = tmp(); // a sibling folder that is not a git repository
    put(plain, 'a.txt', 'x');
    const rel = relative(dir, plain);
    put(dir, '.policy-drift.json', JSON.stringify({ language: 'en', roots: [{ path: '.', baseBranch: 'main' }, { path: rel }],
      policies: [{ type: 'privacy', source: 'file', path: 'docs/privacy.md' }] }));
    const r = await run(dir, 'audit', '--diff', 'main');
    expect(r.stdout).toContain(`${rel}: not a git repository`);
    expect(r.code).toBe(2);
  });
  it('prints a note when the base branch is the current commit', async () => {
    const r = await run(repoWithNewVendor(), 'audit', '--diff');
    expect(r.stdout).toContain('Notes:');
    expect(r.stdout).toContain('cannot be seen');
  });
});

describe('init', () => {
  it('writes a valid example config and never overwrites', async () => {
    const dir = tmp();
    const first = await run(dir, 'init');
    expect(first.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, '.policy-drift.json'), 'utf8'));
    expect(cfg).toMatchObject({ language: 'ko', jurisdictions: ['kr'], roots: [{ path: '.' }] });
    expect(cfg.policies.map((p: { path: string }) => p.path)).toEqual(['docs/privacy.md', 'docs/terms.md']);
    expect(first.stdout).toContain('policies[].path');

    put(dir, '.policy-drift.json', '{"language":"en"}');
    const second = await run(dir, 'init');
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('already exists');
    expect(readFileSync(join(dir, '.policy-drift.json'), 'utf8')).toBe('{"language":"en"}');
  });
});

describe('arguments', () => {
  it('--help and --version print to stdout and exit 0', async () => {
    expect((await run(tmp(), '--help')).stdout).toContain('Usage:');
    const v = await run(tmp(), '--version');
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('unknown command, stray arguments and bad --lang print usage on stderr and exit 2', async () => {
    for (const argv of [['frobnicate'], ['init', 'x'], ['audit', 'main'], ['--diff'], ['audit', '--lang', 'fr'], ['audit', '--nope']]) {
      const r = await run(tmp(), ...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr).toContain('Usage:');
      expect(r.stdout).toBe('');
    }
  });
});
