import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectDependencies } from '../src/detectors/dependencies.js';
import { detectHosts } from '../src/detectors/hosts.js';
import { detectTrackers } from '../src/detectors/trackers.js';
import { listRoot } from '../src/files.js';
import { loadRules, loadVendors } from '../src/registry.js';

const MUST_HAVE = [
  'openai', 'anthropic', 'sentry', 'firebase', 'google-analytics', 'microsoft-clarity', 'meta-pixel',
  'channel-io', 'kakao-alimtalk', 'aws', 'stripe', 'supabase', 'vercel-analytics', 'amplitude', 'mixpanel',
  'posthog', 'datadog', 'hotjar', 'intercom', 'segment', 'resend', 'sendgrid', 'twilio', 'cloudflare',
  'auth0', 'clerk', 'algolia', 'toss-payments', 'portone', 'nhn-cloud', 'stibee',
];

describe('shipped vendor registry', () => {
  const vendors = loadVendors();
  const ids = vendors.map((v) => v.id);

  it('loads about 40 vendors', () => {
    expect(vendors.length).toBeGreaterThanOrEqual(35);
  });

  it('has unique, kebab-case ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('points every parent at an existing id', () => {
    for (const v of vendors) if (v.parent) expect(ids, `${v.id}.parent`).toContain(v.parent);
  });

  it('has an https source and a 2-letter country on every vendor', () => {
    for (const v of vendors) {
      expect(v.source, v.id).toMatch(/^https:\/\//);
      expect(v.country, v.id).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('has names on every vendor and no bare legal suffix as a name', () => {
    for (const v of vendors) {
      expect(v.names.length, v.id).toBeGreaterThan(0);
      // guards against an unquoted "Foo, Inc." being split by YAML into "Foo" and "Inc."
      for (const n of v.names) expect(n, v.id).not.toMatch(/^(inc\.?|llc|ltd\.?|limited|l\.l\.c\.)$/i);
    }
  });

  it('contains the must-have vendors', () => {
    for (const id of MUST_HAVE) expect(ids, id).toContain(id);
  });

  it('keeps Google Analytics and Firebase as separate entries under google', () => {
    expect(vendors.find((v) => v.id === 'google-analytics')?.parent).toBe('google');
    expect(vendors.find((v) => v.id === 'firebase')?.parent).toBe('google');
  });
});

describe('shipped rule packs', () => {
  const packs = loadRules(['kr', 'gdpr']);

  it('loads kr and gdpr', () => {
    expect(packs.map((p) => p.jurisdiction)).toEqual(['kr', 'gdpr']);
  });

  it('gives every section at least one keyword and a basis', () => {
    for (const p of packs) {
      expect(p.sections.length, p.jurisdiction).toBeGreaterThan(0);
      for (const s of p.sections) {
        expect(s.keywords.length, `${p.jurisdiction}/${s.id}`).toBeGreaterThan(0);
        expect(s.basis, `${p.jurisdiction}/${s.id}`).not.toBe('');
      }
    }
  });

  it('has unique section ids and cross-border keywords', () => {
    for (const p of packs) {
      const sid = p.sections.map((s) => s.id);
      expect(new Set(sid).size, p.jurisdiction).toBe(sid.length);
      expect(p.crossBorderKeywords.length, p.jurisdiction).toBeGreaterThan(0);
    }
  });

  it('kr covers the required sections and its notice defaults', () => {
    const kr = packs[0];
    for (const id of ['purpose', 'items', 'retention', 'third_party', 'destruction', 'outsourcing', 'rights',
      'officer', 'cookies', 'safety', 'policy_change']) {
      expect(kr.sections.map((s) => s.id), id).toContain(id);
    }
    // cross-border is checked once, by the crossBorder rule, and only when a non-KR service is used (spec 7.6)
    expect(kr.sections.map((s) => s.id)).not.toContain('cross_border');
    expect(kr.notice).toEqual({ defaultDays: 7, adverseDays: 30 });
  });

  it('gdpr has the Art. 13 items and no fixed notice period', () => {
    const g = packs[1];
    expect(g.sections.length).toBe(12);
    for (const s of g.sections) expect(s.basis).toMatch(/^GDPR Art\. 13\(\d\)\([a-f]\)$/);
    expect(g.notice).toEqual({ defaultDays: 0, adverseDays: 0 });
  });

});

describe('vendor registry precision (item 10)', () => {
  const vendors = loadVendors();
  const root = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'pd-data-'));
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
    return listRoot('t', dir);
  };
  const ids = (hits: { vendorId: string }[]) => hits.map((h) => h.vendorId);

  it('does not treat com.auth0:java-jwt as Auth0, but does the Auth0 SDK', () => {
    expect(ids(detectDependencies(root({ 'build.gradle.kts': 'implementation("com.auth0:java-jwt:4.4.0")\n' }), vendors))).toEqual([]);
    expect(ids(detectDependencies(root({ 'build.gradle.kts': 'implementation("com.auth0:auth0:2.10.0")\n' }), vendors))).toEqual(['auth0']);
  });
  it('attributes gtag.js to Google Analytics and gtm.js to Google Tag Manager', () => {
    const ga = root({ 'ga.ts': 's.src = "https://www.googletagmanager.com/gtag/js?id=G-XXXX";\nfunction gtag(){dataLayer.push(arguments);}\n' });
    expect([...new Set([...ids(detectHosts(ga, vendors)), ...ids(detectTrackers(ga, vendors))])]).toEqual(['google-analytics']);
    const gtm = root({ 'gtm.ts': "w[l].push({'gtm.start': Date.now()});\nj.src = 'https://www.googletagmanager.com/gtm.js?id=' + i;\n" });
    expect([...new Set([...ids(detectHosts(gtm, vendors)), ...ids(detectTrackers(gtm, vendors))])]).toEqual(['google-tag-manager']);
  });
  it('gives Segment findable names and keeps ordinary-word names out of names', () => {
    const seg = vendors.find((v) => v.id === 'segment')!;
    expect(seg.names).toEqual(expect.arrayContaining(['Twilio Segment', 'Segment.io', 'Segment.com', '세그먼트']));
    for (const [id, word] of [['resend', 'Resend'], ['clerk', 'Clerk'], ['meta', 'Meta'], ['segment', 'Segment'], ['stripe', 'Stripe']]) {
      const v = vendors.find((x) => x.id === id)!;
      expect(v.names, id).not.toContain(word);
      expect(v.strictNames, id).toContain(word);
    }
  });
});
