import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { audit, mentions } from '../src/audit.js';
import { splitClauses } from '../src/policies.js';
import { loadRules, loadVendors } from '../src/registry.js';
import type { DataMap, PolicyDoc, PolicyType, RulePack, Vendor } from '../src/types.js';

const v = (id: string, names: string[], country = 'US', parent?: string): Vendor =>
  ({ id, names, country, parent, purpose: 'p', packages: [], domains: [], source: 'https://example.com' });
const vendors = [
  v('google', ['Google', 'Google LLC']), v('firebase', ['Firebase', 'FCM'], 'US', 'google'),
  v('openai', ['OpenAI', '오픈AI']), v('sentry', ['Sentry']), v('channel-io', ['Channel.io', '채널톡'], 'KR'),
];
const rules: RulePack[] = [{
  jurisdiction: 'kr', crossBorderKeywords: ['국외 이전'], notice: { defaultDays: 7, adverseDays: 30 },
  sections: [{ id: 'purpose', title: '처리 목적', keywords: ['처리 목적'], basis: 'test' }],
}];
const doc = (type: PolicyType, text: string): PolicyDoc => ({ type, origin: `${type}.md`, text, clauses: splitClauses(text) });
const map = (...ids: string[]): DataMap => ({
  vendors: ids.map((id) => ({ vendorId: id, via: 'dependency' as const, evidence: [{ root: '.', file: 'package.json', line: 3 }] })),
  piiFields: [], features: [],
});
const FULL = '## 처리 목적\n국외 이전 없음.\n';
const kinds = (fs: ReturnType<typeof audit>) => fs.map((f) => `${f.kind}:${f.subject}`);

describe('mentions', () => {
  it('uses word boundaries for ASCII names, case-insensitively', () => {
    expect(mentions('we use sentryx', 'Sentry')).toBe(false);
    expect(mentions('Sentry, Inc.', 'sentry')).toBe(true);
    expect(mentions('uses Sentry.', 'Sentry')).toBe(true);
    expect(mentions('Channel.io Corp', 'Channel.io')).toBe(true);
    expect(mentions('ChannelXio', 'Channel.io')).toBe(false);
  });
  it('matches Korean and mixed names as substrings', () => {
    expect(mentions('채널톡을 씁니다', '채널톡')).toBe(true);
    expect(mentions('Sentry를 씁니다', 'Sentry')).toBe(true);
    expect(mentions('오픈AI에', '오픈AI')).toBe(true);
  });
});

describe('audit (spec 7.6)', () => {
  it('reports nothing for a service whose name is in the document', () => {
    const f = audit(map('openai'), [doc('privacy', `${FULL}OpenAI 에 위탁합니다.`)], vendors, rules);
    expect(kinds(f)).toEqual([]);
  });
  it('reports vendor_uncertain when only the parent company is named', () => {
    const f = audit(map('firebase'), [doc('privacy', `${FULL}Google LLC 에 위탁합니다.`)], vendors, rules);
    expect(f).toHaveLength(1); // FULL contains the cross-border keyword and the section keyword
    expect(f[0]).toMatchObject({ kind: 'vendor_uncertain', subject: 'Firebase' });
    expect(f[0].detail).toContain('Google');
  });
  it('reports vendor_missing, with the vendor evidence, when neither name nor parent appears', () => {
    const f = audit(map('openai'), [doc('privacy', FULL)], vendors, rules);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'vendor_missing', policy: 'privacy', subject: 'OpenAI', evidence: [{ file: 'package.json', line: 3 }] });
  });
  it('does not match a name inside a longer word (sentryx)', () => {
    const f = audit(map('sentry'), [doc('privacy', `${FULL}sentryx 를 씁니다`)], vendors, rules);
    expect(f.map((x) => x.kind)).toEqual(['vendor_missing']);
  });
  it('reports a required section as a candidate when none of its keywords appear', () => {
    const f = audit(map(), [doc('privacy', '## 위탁\n내용')], vendors, rules);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'section_missing_candidate', subject: '처리 목적', evidence: [{ root: 'privacy.md', file: 'privacy.md', line: 1 }] });
    expect(f[0].detail).toBe('no keyword found | 처리 목적');
  });
  it('reports one cross_border candidate when a foreign vendor is used and no keyword appears', () => {
    const f = audit(map('openai', 'sentry', 'channel-io'), [doc('privacy', '## 처리 목적\nOpenAI Sentry 채널톡')], vendors, rules);
    expect(f.map((x) => x.kind)).toEqual(['cross_border_missing_candidate']);
    expect(f[0].detail).toContain('OpenAI (US)');
    expect(f[0].detail).not.toContain('채널톡'); // KR vendor is not foreign
    expect(f[0].evidence).toEqual([
      { root: '.', file: 'package.json', line: 3 }, { root: '.', file: 'package.json', line: 3 }, { root: 'privacy.md', file: 'privacy.md', line: 1 },
    ]);
  });
  it('does not report cross-border when only Korean vendors are used', () => {
    const f = audit(map('channel-io'), [doc('privacy', '## 처리 목적\n채널톡')], vendors, rules);
    expect(f).toEqual([]);
  });
  it('reports broken references from the terms document as confirmed', () => {
    const terms = doc('terms', readFileSync('test/fixtures/policies/terms.md', 'utf8'));
    const f = audit(map(), [terms], vendors, rules);
    expect(f.map((x) => x.kind)).toEqual(['broken_reference', 'broken_reference', 'broken_reference']);
  });
  it('skips vendor and section checks when there is no privacy document', () => {
    const f = audit(map('openai'), [doc('terms', '# 약관\n내용')], vendors, rules);
    expect(f).toEqual([]);
  });
  it('is deterministic', () => {
    const run = () => audit(map('openai', 'sentry'), [doc('privacy', FULL)], vendors, rules);
    expect(run()).toEqual(run());
  });

  it('gives every finding at least one evidence location (item 12)', () => {
    const f = audit(map('openai', 'firebase'), [doc('privacy', '## 위탁\nGoogle'), doc('terms', '## 제1조 (가)\n제9조에 따라')], vendors, rules);
    expect(new Set(f.map((x) => x.kind)).size).toBe(5);
    for (const x of f) expect(x.evidence.length, x.kind).toBeGreaterThan(0);
  });
});

describe('audit with the shipped registry and kr rules', () => {
  const real = loadVendors();
  const kr = loadRules(['kr']);
  const subjects = (ids: string[], text: string) => audit(map(...ids), [doc('privacy', text)], real, kr).map((f) => `${f.kind}:${f.subject}`);

  it('does not report cross-border for Korean-only services (item 4)', () => {
    expect(subjects(['channel-io'], '## 안내\n채널톡').filter((s) => s.startsWith('cross_border') || s.includes('국외'))).toEqual([]);
  });
  it('matches strictNames case-sensitively as whole words (item 10)', () => {
    expect(subjects(['resend'], 'We resend emails.')).toContain('vendor_missing:Resend');
    expect(subjects(['resend'], 'Resend 에 위탁합니다.')).not.toContain('vendor_missing:Resend');
    expect(subjects(['meta-pixel'], 'meta tags 를 씁니다.')).toContain('vendor_missing:Meta Pixel');
    expect(subjects(['meta-pixel'], 'Meta 에 제공합니다.')).toContain('vendor_uncertain:Meta Pixel');
    expect(subjects(['segment'], 'Segment.io 에 위탁합니다.')).not.toContain('vendor_missing:Segment');
    expect(subjects(['segment'], 'the data segment is stored.')).toContain('vendor_missing:Segment');
    expect(subjects(['clerk'], 'a clerk reviews it')).toContain('vendor_missing:Clerk');
  });
});
