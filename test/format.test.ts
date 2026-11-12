import { describe, expect, it } from 'vitest';
import { answerFormat, DISCLAIMER, displayWidth, renderAudit, renderChanges, table } from '../src/format.js';
import type { AuditFinding, Changes } from '../src/types.js';

const finding = (over: Partial<AuditFinding>): AuditFinding => ({
  kind: 'vendor_missing', policy: 'privacy', subject: 'OpenAI', detail: 'not mentioned | OpenAI, 오픈AI',
  evidence: [{ root: '.', file: 'package.json', line: 3 }], ...over,
});

describe('answerFormat', () => {
  it('ko carries the spec section 6 format and its fixed rules', () => {
    const t = answerFormat('ko');
    for (const s of ['조항', '이유:', '근거:', '현재 문구:', '제안 문구:', '확신:', '`높음`', '`확인 필요`',
      '이번 변경은 약관·처리방침에 영향 없음', 'get_policies', '개정 조항', 'notice 기본값', DISCLAIMER.ko]) expect(t).toContain(s);
    expect(t).toMatch(/불리한.*항상 `확인 필요`/);
    expect(t.trimEnd().endsWith(DISCLAIMER.ko)).toBe(true);
  });
  it('en is the English equivalent', () => {
    const t = answerFormat('en');
    for (const s of ['Reason:', 'Evidence:', 'Current wording:', 'Proposed wording:', 'Confidence:', '`high`', '`needs review`',
      'No impact on the terms or privacy policy', 'get_policies', 'amendment clause', 'Never invent clause text', DISCLAIMER.en]) expect(t).toContain(s);
    expect(t).toMatch(/never claim legal compliance/i);
    expect(t.trimEnd().endsWith(DISCLAIMER.en)).toBe(true);
  });
});

describe('table', () => {
  it('pads by display width so Korean columns line up', () => {
    expect(displayWidth('채널톡')).toBe(6);
    const rows = table([['a', 'b'], ['채널톡', 'x'], ['ab', 'y']]).split('\n');
    const col = (r: string) => displayWidth(r.slice(0, -1)); // last column is one character wide
    expect(new Set(rows.map(col)).size).toBe(1);
  });
});

describe('renderAudit', () => {
  const all: AuditFinding[] = [
    finding({}),
    finding({ kind: 'vendor_uncertain', subject: 'Firebase', detail: 'only parent company mentioned | Google' }),
    finding({ kind: 'section_missing_candidate', subject: '처리 목적', detail: 'no keyword found | 처리 목적', evidence: [{ root: 'privacy.md', file: 'privacy.md', line: 1 }] }),
    finding({ kind: 'cross_border_missing_candidate', subject: 'cross-border transfer', detail: 'no cross-border keyword found | OpenAI (US)' }),
    finding({ kind: 'broken_reference', policy: 'terms', subject: '제4조', detail: '제2조 제3항', evidence: [{ root: 'terms.md', file: 'terms.md', line: 9 }] }),
  ];
  it('uses the ko display labels and ends with the disclaimer', () => {
    const t = renderAudit(all, 'ko');
    for (const s of ['언급 없음', '확인 필요', '항목 없음 (후보)', '참조 오류', '국외 이전', '발견 5건', 'package.json:3', 'terms.md:9']) expect(t).toContain(s);
    expect(t.trimEnd().endsWith(DISCLAIMER.ko)).toBe(true);
  });
  it('uses the en display labels', () => {
    const t = renderAudit(all, 'en');
    for (const s of ['Not mentioned', 'Needs review', 'Section missing (candidate)', 'Broken reference', 'Cross-border transfer', '5 findings']) expect(t).toContain(s);
    expect(t.trimEnd().endsWith(DISCLAIMER.en)).toBe(true);
  });
  it('says so when there is nothing to report', () => {
    expect(renderAudit([], 'ko')).toContain('발견된 항목이 없습니다');
    expect(renderAudit([], 'en')).toContain('found nothing');
  });
});

describe('renderChanges', () => {
  const empty = { vendors: [], piiFields: [], features: [] };
  it('lists added, removed, rule candidates and skipped roots', () => {
    const changes: Changes = {
      added: { vendors: [{ vendorId: 'openai', via: 'dependency', evidence: [{ root: '../api', file: 'build.gradle.kts', line: 7 }] }], piiFields: [],
        features: [{ name: 'challenges', evidence: { root: '.', file: 'app/challenges/page.tsx', line: 1 } }] },
      removed: { ...empty, features: [{ name: 'old', evidence: { root: '.', file: 'schema.graphqls', line: 4 } }] },
      ruleCandidates: [{ root: '.', file: 'Retry.kt', line: 18, before: '3', after: '5', keyword: 'retry', text: '+ val MAX_RETRY = 5' }],
      skipped: [{ root: '../x', reason: 'not a git repository' }],
      notes: ['.: the base branch "main" is the current commit'],
    };
    const t = renderChanges(changes, 'en', [finding({})]);
    for (const s of ['Added', 'Removed', 'openai (dependency)', '../api/build.gradle.kts:7', 'challenges', '3 -> 5 (retry)', 'Retry.kt:18',
      '../x: not a git repository', 'Not mentioned', 'app/challenges/page.tsx:1', 'schema.graphqls:4', 'Notes:', 'the base branch "main" is the current commit']) expect(t).toContain(s);
    expect(t.trimEnd().endsWith(DISCLAIMER.en)).toBe(true);
  });
  it('says nothing changed for an empty result', () => {
    expect(renderChanges({ added: empty, removed: empty, ruleCandidates: [], skipped: [], notes: [] }, 'ko')).toContain('달라진 점이 없습니다');
  });
});

describe('answerFormat skipped / notes rule (item 5)', () => {
  it('forbids the no-impact line when roots were skipped or notes exist', () => {
    expect(answerFormat('ko')).toMatch(/`skipped`.*`notes`[\s\S]*영향 없음/);
    expect(answerFormat('en')).toMatch(/`skipped`.*`notes`[\s\S]*no impact/i);
  });
});

describe('renderAudit layout (items C, D)', () => {
  it('prints a URL origin as "<origin> (line N)"', () => {
    const t = renderAudit([finding({ kind: 'broken_reference', policy: 'terms', subject: '제3조', detail: '제9조',
      evidence: [{ root: 'https://api.example.test/graphql', file: 'https://api.example.test/graphql', line: 157 }] })], 'en');
    expect(t).toContain('https://api.example.test/graphql (line 157)');
    expect(t).not.toContain('graphql:157');
  });
  it('groups by document, then by kind', () => {
    const fs = [
      finding({ kind: 'broken_reference', policy: 'terms', subject: '제4조', detail: '제9조', evidence: [{ root: 't.md', file: 't.md', line: 3 }] }),
      finding({ subject: 'OpenAI' }),
      finding({ kind: 'section_missing_candidate', subject: '처리 목적', detail: 'no keyword found | 처리 목적', evidence: [{ root: 'p.md', file: 'p.md', line: 1 }] }),
      finding({ subject: 'Sentry' }),
    ];
    const t = renderAudit(fs, 'en');
    const at = (s: string) => t.indexOf(s);
    expect(at('Privacy policy (3)')).toBeGreaterThan(-1);
    expect(at('Terms (1)')).toBeGreaterThan(at('Privacy policy (3)'));
    expect(at('Not mentioned (2)')).toBeLessThan(at('Section missing (candidate) (1)'));
    expect(at('Sentry')).toBeLessThan(at('Section missing (candidate) (1)')); // both vendors sit under one kind heading
  });
  it('prints evidence paths relative to the cwd when inside it', () => {
    const t = renderAudit([finding({ evidence: [{ root: '/work/app/api', file: 'build.gradle', line: 2 }] })], 'en', '/work/app');
    expect(t).toContain('api/build.gradle:2');
    expect(t).not.toContain('/work/app/api');
    const out = renderAudit([finding({ evidence: [{ root: '/elsewhere', file: 'a.ts', line: 2 }] })], 'en', '/work/app');
    expect(out).toContain('/elsewhere/a.ts:2');
  });
});

describe('answerFormat statute citation rule', () => {
  it('forbids citing article numbers from memory in both languages', () => {
    expect(answerFormat('ko')).toMatch(/조문 번호.*기억으로 적지 않는다[\s\S]*근거 법령 확인 필요/);
    expect(answerFormat('en')).toMatch(/article numbers from memory[\s\S]*legal basis needs checking/);
  });
});
