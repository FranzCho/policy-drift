import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listRoot } from '../src/files.js';
import { scanDataMap } from '../src/scan.js';
import type { Vendor } from '../src/types.js';

const v = (id: string, p: Partial<Vendor>): Vendor =>
  ({ id, names: [id], country: 'US', purpose: 'x', packages: [], domains: [], source: 'https://example.com', ...p });
const VENDORS = [
  v('openai', { packages: ['openai'], domains: ['api.openai.com'] }),
  v('google-analytics', { trackers: ['gtag('] }),
  v('anthropic', { packages: ['spring-ai-starter-model-anthropic'] }),
];
const mk = (label: string, files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-scan-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return listRoot(label, dir);
};

describe('scanDataMap', () => {
  it('merges the same vendor+via into one hit and sorts everything', () => {
    const map = scanDataMap([listRoot('app', resolve('test/fixtures/app'))], VENDORS);
    expect(map.vendors.map((h) => `${h.vendorId}/${h.via}`)).toEqual([
      'anthropic/dependency', 'google-analytics/tracker', 'openai/dependency', 'openai/host',
    ]);
    expect(map.vendors.find((h) => h.vendorId === 'openai' && h.via === 'dependency')!.evidence).toHaveLength(2);
    expect(map.piiFields.map((p) => p.key)).toEqual(['address', 'birth', 'email', 'email', 'email', 'phone']);
    expect(map.features.map((f) => f.name)).toEqual(['/', '/challenges', 'challenge', 'challenges', 'createChallenge']);
  });

  it('merges across roots, keeping evidence from both sorted by root then file then line', () => {
    const b = mk('b', { 'package.json': '{ "dependencies": { "openai": "1" } }', 'app/page.tsx': '' });
    const a = mk('a', { 'package.json': '{\n"dependencies": { "openai": "1" } }', 'schema.graphqls': 'type Query { me: Int }' });
    const map = scanDataMap([b, a], VENDORS);
    expect(map.vendors).toEqual([
      { vendorId: 'openai', via: 'dependency', evidence: [
        { root: 'a', file: 'package.json', line: 2 }, { root: 'b', file: 'package.json', line: 1 },
      ] },
    ]);
    expect(map.features).toEqual([
      { name: '/', evidence: { root: 'b', file: 'app/page.tsx', line: 1 } },
      { name: 'me', evidence: { root: 'a', file: 'schema.graphqls', line: 1 } },
    ]);
  });

  it('returns an empty map for unrelated files, and the same result twice (any root order)', () => {
    const empty = mk('e', { 'README.md': 'hi', 'x.txt': 'y' });
    expect(scanDataMap([empty], VENDORS)).toEqual({ vendors: [], piiFields: [], features: [] });
    const app = listRoot('app', resolve('test/fixtures/app'));
    expect(scanDataMap([app, empty], VENDORS)).toEqual(scanDataMap([empty, app], VENDORS));
    expect(scanDataMap([app], VENDORS)).toEqual(scanDataMap([app], VENDORS));
  });
});
