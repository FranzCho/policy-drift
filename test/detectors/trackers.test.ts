import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectTrackers } from '../../src/detectors/trackers.js';
import { listRoot } from '../../src/files.js';
import type { Vendor } from '../../src/types.js';

const v = (id: string, trackers?: string[]): Vendor =>
  ({ id, names: [id], country: 'US', purpose: 'x', packages: [], domains: [], trackers, source: 'https://example.com' });
const VENDORS = [v('google-analytics', ['gtag(']), v('channel-io', ['ChannelIO(']), v('openai')];
const mk = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-trk-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return listRoot('t', dir);
};

describe('detectTrackers', () => {
  it('finds gtag( in the fixture tsx with its line', () => {
    const app = listRoot('app', resolve('test/fixtures/app'));
    expect(detectTrackers(app, VENDORS)).toEqual([
      { vendorId: 'google-analytics', via: 'tracker', evidence: [{ root: 'app', file: 'src/components/Support.tsx', line: 2 }] },
    ]);
  });

  it('matches calls (incl. window.gtag) but not longer identifiers; reads only front-end files', () => {
    const root = mk({
      'a.ts': 'mygtag(1)\nwindow.gtag("x")\nChannelIO("boot")\n',
      'index.html': '<script>gtag("js", new Date())</script>',
      'b.py': 'gtag(1)',
      'c.kt': 'gtag(1)',
    });
    expect(detectTrackers(root, VENDORS)).toEqual([
      { vendorId: 'channel-io', via: 'tracker', evidence: [{ root: 't', file: 'a.ts', line: 3 }] },
      { vendorId: 'google-analytics', via: 'tracker', evidence: [{ root: 't', file: 'a.ts', line: 2 }, { root: 't', file: 'index.html', line: 1 }] },
    ]);
  });

  it('skips test files', () => {
    const root = mk({ 'a.test.tsx': 'gtag(1)', 'b.spec.ts': 'gtag(1)', '__tests__/c.ts': 'gtag(1)' });
    expect(detectTrackers(root, VENDORS)).toEqual([]);
  });

  it('returns [] for unrelated files and is deterministic', () => {
    expect(detectTrackers(mk({ 'README.md': 'gtag(1)' }), VENDORS)).toEqual([]);
    const app = listRoot('app', resolve('test/fixtures/app'));
    expect(detectTrackers(app, VENDORS)).toEqual(detectTrackers(app, VENDORS));
  });
});
