import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRules, loadVendors } from '../src/registry.js';

const fx = (name: string) => join(import.meta.dirname, 'fixtures', name);
const tmpDirWith = (file: string, content: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-registry-'));
  writeFileSync(join(dir, file), content);
  return dir;
};

describe('loadVendors', () => {
  it('reads vendors.yaml', () => {
    const vendors = loadVendors(fx('registry'));
    expect(vendors.map((v) => v.id)).toEqual(['openai', 'channel-io']);
    expect(vendors[1]).toMatchObject({ country: 'KR', names: expect.arrayContaining(['채널톡']), trackers: ['ChannelIO('] });
    expect(vendors[0].trackers).toBeUndefined();
  });

  it('rejects a vendor without source, naming it', () => {
    const dir = tmpDirWith('vendors.yaml', '- id: acme\n  names: [Acme]\n  country: US\n  purpose: x\n  packages: []\n  domains: []\n');
    expect(() => loadVendors(dir)).toThrow(/acme.*source/s);
  });

  it('rejects a vendor with an empty source', () => {
    const dir = tmpDirWith('vendors.yaml', '- id: acme\n  names: [Acme]\n  country: US\n  purpose: x\n  packages: []\n  domains: []\n  source: ""\n');
    expect(() => loadVendors(dir)).toThrow(/acme.*source/s);
  });
});

describe('loadRules', () => {
  it('reads one pack per jurisdiction', () => {
    const [kr] = loadRules(['kr'], fx('rules'));
    expect(kr.jurisdiction).toBe('kr');
    expect(kr.sections).toHaveLength(2);
    expect(kr.notice).toEqual({ defaultDays: 7, adverseDays: 30 });
  });

  it('throws naming the jurisdiction when its file is missing', () => {
    expect(() => loadRules(['kr', 'gdpr'], fx('rules'))).toThrow(/gdpr/);
  });
});
