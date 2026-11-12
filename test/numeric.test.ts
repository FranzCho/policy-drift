import { describe, expect, it } from 'vitest';
import { findRuleCandidates } from '../src/numeric.js';

const diff = (file: string, hunks: string[]) =>
  [`diff --git a/${file} b/${file}`, 'index 111..222 100644', `--- a/${file}`, `+++ b/${file}`, ...hunks].join('\n') + '\n';

describe('findRuleCandidates', () => {
  it('reports a changed number on a keyword line, with new-file line number', () => {
    const d = diff('src/billing.ts', ['@@ -10 +12 @@', '-const MAX_RETRY = 3;', '+const MAX_RETRY = 5;']);
    expect(findRuleCandidates('app', d)).toEqual([
      { root: 'app', file: 'src/billing.ts', line: 12, before: '3', after: '5', keyword: 'retry', text: 'const MAX_RETRY = 5;' },
    ]);
  });

  it('matches the keyword in the file path alone, case-insensitively', () => {
    const d = diff('src/Payment/limits.ts', ['@@ -1 +1 @@', '-const LIMIT = 10;', '+const LIMIT = 20;']);
    expect(findRuleCandidates('r', d)).toMatchObject([{ keyword: 'payment', before: '10', after: '20' }]);
  });

  it('matches Korean keywords', () => {
    const d = diff('a.ts', ['@@ -1 +1 @@', "-const 환불기한 = 7;", "+const 환불기한 = 14;"]);
    expect(findRuleCandidates('r', d)).toMatchObject([{ keyword: '환불', before: '7', after: '14' }]);
  });

  it('ignores number changes without a keyword', () => {
    const d = diff('src/net.ts', ['@@ -1 +1 @@', '-const TIMEOUT = 3;', '+const TIMEOUT = 5;']);
    expect(findRuleCandidates('r', d)).toEqual([]);
  });

  it('ignores changes that are not only numbers', () => {
    const d = diff('src/pay.ts', ['@@ -1 +1 @@', '-const retries = 3;', '+const attempts = 3;']);
    expect(findRuleCandidates('r', d)).toEqual([]);
    const e = diff('src/pay.ts', ['@@ -1 +1 @@', '-const retries = 3;', '+const retries = 3; // same']);
    expect(findRuleCandidates('r', e)).toEqual([]);
  });

  it('reports one candidate per differing number position', () => {
    const d = diff('src/pay.ts', ['@@ -4 +4 @@', '-range(1, 3, 10)', '+range(1, 5, 20)']);
    expect(findRuleCandidates('r', d).map((c) => [c.before, c.after])).toEqual([['3', '5'], ['10', '20']]);
  });

  it('handles decimals and underscore separators', () => {
    const d = diff('src/point.ts', ['@@ -1,2 +1,2 @@', '-const rate = 0.5;', '-const cap = 1_000;', '+const rate = 0.75;', '+const cap = 2_000;']);
    const c = findRuleCandidates('r', d);
    expect(c.map((x) => [x.line, x.before, x.after])).toEqual([[1, '0.5', '0.75'], [2, '1_000', '2_000']]);
  });

  it('pairs lines with the same number-masked text inside a hunk and tracks lines per hunk', () => {
    const d = diff('src/refund.ts', [
      '@@ -3,2 +3,2 @@', '-const a = 1;', '-const b = 2;', '+const a = 1;', '+const b = 9;',
      '@@ -20 +21,2 @@', '-const c = 5;', '+const c = 6;', '+const d = 1;',
    ]);
    expect(findRuleCandidates('r', d).map((c) => [c.line, c.before, c.after])).toEqual([[4, '2', '9'], [21, '5', '6']]);
  });

  it('does not treat digits inside identifiers as numeric literals', () => {
    const d = diff('src/pay.ts', ['@@ -1 +1 @@', '-const retry2 = 1;', '+const retry3 = 1;']);
    expect(findRuleCandidates('r', d)).toEqual([]);
  });

  it('skips test, spec, snapshot, markdown, mdx and lock files', () => {
    const hunk = ['@@ -1 +1 @@', '-retry = 3', '+retry = 5'];
    const files = ['a.test.ts', 'a.spec.tsx', 'src/__tests__/a.ts', 'a.snap', 'README.md', 'docs/a.mdx', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
    expect(findRuleCandidates('r', files.map((f) => diff(f, hunk)).join(''))).toEqual([]);
  });

  it('follows the file across several file sections and sorts output', () => {
    const hunk = ['@@ -1 +1 @@', '-retry = 3', '+retry = 5'];
    const d = diff('b.ts', hunk) + diff('a.ts', hunk);
    expect(findRuleCandidates('r', d).map((c) => c.file)).toEqual(['a.ts', 'b.ts']);
  });

  it('ignores deleted files and empty input', () => {
    const d = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-retry = 3\n';
    expect(findRuleCandidates('r', d)).toEqual([]);
    expect(findRuleCandidates('r', '')).toEqual([]);
  });

  it('pairs by masked text, not position (item 7)', () => {
    const d = diff('src/pay.ts', ['@@ -1,2 +1 @@', '- // retries', '- MAX_RETRY = 3', '+ MAX_RETRY = 5']);
    expect(findRuleCandidates('r', d).map((c) => [c.before, c.after])).toEqual([['3', '5']]);
    const e = diff('src/pay.ts', ['@@ -1,2 +1 @@', '-retry = 1', '-retry = 2', '+retry = 2']); // retry = 1 was deleted
    expect(findRuleCandidates('r', e)).toEqual([]);
  });

  it('matches English keywords on identifier tokens only (item 8)', () => {
    const hit = (file: string, b: string, a: string) => findRuleCandidates('r', diff(file, ['@@ -1 +1 @@', `-${b}`, `+${a}`]));
    expect(hit('src/api.ts', 'const ENDPOINT_TIMEOUT = 3;', 'const ENDPOINT_TIMEOUT = 5;')).toEqual([]);
    expect(hit('src/layout.ts', 'const breakpoints = [640];', 'const breakpoints = [768];')).toEqual([]);
    expect(hit('src/payload.ts', 'const maxSize = 3;', 'const maxSize = 5;')).toEqual([]);
    for (const [name, kw] of [['refundedDays', 'refunded'], ['PAYMENTS_LIMIT', 'payments'], ['tokenExpiration', 'expiration'],
      ['withdrawal_days', 'withdrawal'], ['pointsRate', 'points'], ['retries', 'retries'], ['expired-after', 'expired']]) {
      expect(hit('src/x.ts', `const ${name} = 3;`, `const ${name} = 4;`).map((c) => c.keyword), name).toEqual([kw]);
    }
  });

  it('skips manifests, version files and style files (item 8)', () => {
    const hunk = ['@@ -1 +1 @@', '-"payment-sdk": "1.2.3"', '+"payment-sdk": "1.2.4"'];
    const files = ['package.json', 'web/package.json', 'Cargo.toml', 'build.gradle', 'app/build.gradle.kts', 'gradle.properties', 'Gemfile.lock', 'retry.css', 'pay.scss'];
    expect(findRuleCandidates('r', files.map((f) => diff(f, hunk)).join(''))).toEqual([]);
  });

  it('ignores numbers inside class strings, CSS-like units, and digits glued to - or letters (item 8)', () => {
    const hit = (b: string, a: string) => findRuleCandidates('r', diff('src/payment/Card.tsx', ['@@ -1 +1 @@', `-${b}`, `+${a}`]));
    expect(hit('<div className="p-4 gap-8">', '<div className="p-6 gap-2">')).toEqual([]);
    expect(hit("<div class='mt-2'>", "<div class='mt-3'>")).toEqual([]);
    expect(hit("style={{ paddingTop: '8px', width: 50% }}", "style={{ paddingTop: '12px', width: 60% }}")).toEqual([]);
    expect(hit('const api = "v2";', 'const api = "v3";')).toEqual([]);
    expect(hit('<div className="p-4">{3} payments</div>', '<div className="p-6">{5} payments</div>').map((c) => [c.before, c.after]))
      .toEqual([['3', '5']]);
    expect(hit('const delta = -1;', 'const delta = -2;')).toHaveLength(1);
  });

  it('skips JVM, Python and Go test layouts (item 18)', () => {
    const hunk = ['@@ -1 +1 @@', '-retry = 3', '+retry = 5'];
    const files = ['src/test/kotlin/PayTest.kt', 'api/RetryTests.java', 'PaySpec.groovy', 'RetrySpec.kt', 'pay_test.py', 'pay_test.go',
      'test_pay.py', 'tests/pay.ts', 'e2e/pay.ts', '__mocks__/pay.ts', 'fixtures/pay.ts'];
    expect(findRuleCandidates('r', files.map((f) => diff(f, hunk)).join(''))).toEqual([]);
  });
});
