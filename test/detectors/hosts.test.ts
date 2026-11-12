import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectHosts } from '../../src/detectors/hosts.js';
import { listRoot } from '../../src/files.js';
import type { Vendor } from '../../src/types.js';

const v = (id: string, domains: string[]): Vendor =>
  ({ id, names: [id], country: 'US', purpose: 'x', packages: [], domains, source: 'https://example.com' });
const VENDORS = [v('openai', ['api.openai.com']), v('channel-io', ['channel.io', 'cdn.channel.io'])];
const mk = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-host-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return listRoot('t', dir);
};

describe('detectHosts', () => {
  it('finds the domain in the fixture yml with its line', () => {
    const app = listRoot('app', resolve('test/fixtures/app'));
    expect(detectHosts(app, VENDORS)).toEqual([
      { vendorId: 'openai', via: 'host', evidence: [{ root: 'app', file: 'config/application.yml', line: 3 }] },
    ]);
  });

  it('matches whole host tokens only', () => {
    const root = mk({
      'a.ts': [
        'fetch("https://api.openai.com/v1")', // 1 hit
        'const a = "notapi.openai.com"', // mid-label prefix
        'const b = "api.openai.com.evil.example"', // continues as another host
        'const c = "api.openai.community"',
        'const d = "support@channel.io"', // email address
        'const e = "x-channel.io"',
        'const f = "https://eu.channel.io/x"', // subdomain of a listed domain: hit
        'const g = "api.openai.com."', // sentence end: hit
      ].join('\n'),
    });
    expect(detectHosts(root, VENDORS)).toEqual([
      { vendorId: 'channel-io', via: 'host', evidence: [{ root: 't', file: 'a.ts', line: 7 }] },
      { vendorId: 'openai', via: 'host', evidence: [{ root: 't', file: 'a.ts', line: 1 }, { root: 't', file: 'a.ts', line: 8 }] },
    ]);
  });

  it('skips lock files, test files and non-source extensions; reads .env files', () => {
    const host = 'https://api.openai.com';
    const root = mk({
      'package-lock.json': host,
      'pnpm-lock.yaml': host,
      'yarn.lock': host,
      'gradle.lockfile': host,
      'src/a.test.ts': host,
      'src/a.spec.js': host,
      'src/__tests__/b.ts': host,
      'README.md': host,
      '.env.local': `OPENAI_URL=${host}`,
      'src/App.kt': host,
    });
    expect(detectHosts(root, VENDORS)).toEqual([
      { vendorId: 'openai', via: 'host', evidence: [{ root: 't', file: '.env.local', line: 1 }, { root: 't', file: 'src/App.kt', line: 1 }] },
    ]);
  });

  it('is case-insensitive, one evidence per line, [] when nothing matches, deterministic', () => {
    const root = mk({ 'a.ts': 'API.OpenAI.com and api.openai.com\n' });
    expect(detectHosts(root, VENDORS)[0].evidence).toHaveLength(1);
    expect(detectHosts(mk({ 'a.ts': 'nothing' }), VENDORS)).toEqual([]);
    expect(detectHosts(root, VENDORS)).toEqual(detectHosts(root, VENDORS));
  });

  it('supports host/path-prefix domains (item 10)', () => {
    const vs = [v('gtm', ['googletagmanager.com/gtm.js']), v('ga', ['googletagmanager.com/gtag/'])];
    const root = mk({ 'a.ts': 'load("https://www.googletagmanager.com/gtag/js?id=G-X")\nload("https://www.googletagmanager.com/gtm.js?id=GTM-X")\n"googletagmanager.com"' });
    expect(detectHosts(root, vs).map((h) => [h.vendorId, h.evidence.map((e) => e.line)])).toEqual([['ga', [1]], ['gtm', [2]]]);
  });
});
