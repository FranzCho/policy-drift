import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchPolicies, htmlToText, splitClauses } from '../src/policies.js';
import type { Config, PolicySource } from '../src/types.js';

const dir = join(import.meta.dirname, 'fixtures/policies');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const cfg = (...policies: PolicySource[]): Config => ({ language: 'ko', jurisdictions: ['kr'], roots: [], policies });
const reply = (body: string | object, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('htmlToText', () => {
  const text = htmlToText(read('page.html'));
  it('drops script, style, nav, footer, head', () => {
    for (const w of ['secret', 'color: red', '메뉴1', 'copyright', 'script', '<h1']) expect(text).not.toContain(w);
  });
  it('keeps <header> content, which often holds article headings', () => {
    expect(htmlToText('<article><header><h2>제1조 (목적)</h2></header><p>본문</p></article>')).toBe('## 제1조 (목적)\n본문');
  });
  it('decodes numeric entities and &middot;', () => {
    expect(htmlToText('<p>A&#183;B&middot;C &#x27;D&#x27; &#xAC00; &#1114112;</p>')).toBe("A·B·C 'D' 가 &#1114112;");
  });
  it('turns headings into # lines and keeps line breaks', () => {
    expect(text).toContain('# 개인정보 처리방침');
    expect(text).toContain('## 제1조 (목적)');
    expect(text).toContain('회사는 A&B 서비스를 운영합니다.\n문의는');
    expect(text).toContain('첫째\n둘째');
  });
  it('restores the five entities and nbsp', () => {
    expect(text).toContain('<support> 로 보내세요. "감사" \'합니다\'');
  });
});

describe('splitClauses', () => {
  it('splits terms.md by heading styles and derives art ids', () => {
    const cs = splitClauses(read('terms.md'));
    expect(cs.map((c) => c.id)).toEqual(['예시서비스-이용약관', 'art-1', 'art-2', 'art-3', 'art-4', 'art-5']);
    expect(cs[3].title).toBe('제 3조 (이용계약의 성립)');
    expect(cs[4].title).toBe('제4조 (서비스의 변경)');
    expect(cs.map((c) => c.line)).toEqual([1, 3, 7, 14, 17, 20]);
    expect(cs[1].body).toContain('제17조');
  });
  it('derives sec ids from numbered privacy headings', () => {
    const cs = splitClauses(read('privacy.md'));
    expect(cs.map((c) => c.id)).toEqual(['sec-1', 'sec-2', 'sec-4']);
    expect(cs[2].title).toBe('4. 개인정보 처리 위탁');
  });
  it('falls back to a slug and suffixes duplicate ids', () => {
    const cs = splitClauses('## Overview\na\n## Overview\nb\n## 제1조 (가)\n## 제1조 (나)\n');
    expect(cs.map((c) => c.id)).toEqual(['overview', 'overview-2', 'art-1', 'art-1-2']);
  });
  it('keeps text before the first heading as preamble only when non-empty', () => {
    const cs = splitClauses('안내문\n## 제1조 (가)\n본문');
    expect(cs[0]).toMatchObject({ id: 'preamble', body: '안내문', line: 1 });
    expect(splitClauses('\n\n## 제1조 (가)\n본문').map((c) => c.id)).toEqual(['art-1']);
  });
  it('drops MDX import/export lines but keeps line numbers', () => {
    const cs = splitClauses("import X from './x'\nexport const a = 1\n\n## 제1조 (가)\n본문");
    expect(cs.map((c) => c.id)).toEqual(['art-1']);
    expect(cs[0].line).toBe(4);
  });
  it('does not treat a body line that merely starts with a reference as a heading', () => {
    const cs = splitClauses('## 제1조 (가)\n제2조에 따라 처리합니다.\n제3조 및 제4조도 같습니다.');
    expect(cs).toHaveLength(1);
  });
});

describe('fetchPolicies', () => {
  it('reads file sources relative to cwd and splits clauses', async () => {
    const { docs, errors } = await fetchPolicies(cfg({ type: 'terms', source: 'file', path: 'terms.md' }), dir);
    expect(errors).toEqual([]);
    expect(docs[0]).toMatchObject({ type: 'terms', origin: 'terms.md' });
    expect(docs[0].clauses).toHaveLength(6);
  });

  it('reports a missing file without throwing', async () => {
    const { docs, errors } = await fetchPolicies(cfg({ type: 'privacy', source: 'file', path: 'nope.md' }), dir);
    expect(docs).toEqual([]);
    expect(errors).toEqual([{ type: 'privacy', origin: 'nope.md', message: 'file not found: nope.md' }]);
  });

  it('puts an HTTP 500 into errors and still returns the other documents', async () => {
    const fetchFake = (async (u: string | URL | Request) =>
      String(u).includes('bad') ? reply('x', 500) : reply('<h2>제1조 (가)</h2><p>본문</p>')) as typeof fetch;
    const { docs, errors } = await fetchPolicies(
      cfg(
        { type: 'privacy', source: 'url', url: 'https://x.test/bad' },
        { type: 'terms', source: 'url', url: 'https://x.test/ok' },
      ),
      dir,
      { fetch: fetchFake },
    );
    expect(errors).toEqual([{ type: 'privacy', origin: 'https://x.test/bad', message: 'HTTP 500' }]);
    expect(docs).toHaveLength(1);
    expect(docs[0].clauses[0].id).toBe('art-1');
  });

  it('posts http-json with substituted headers and picks by dot path with array index', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchFake = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return reply({ data: { list: [{ body: '## 제1조 (가)\n본문' }] } });
    }) as unknown as typeof fetch;
    const { docs, errors } = await fetchPolicies(
      cfg({
        type: 'terms', source: 'http-json', url: 'https://api.test/g', format: 'markdown',
        headers: { Authorization: 'Bearer ${POLICY_DRIFT_TOKEN}' }, body: { q: 1 }, pick: 'data.list.0.body',
      }),
      dir,
      { fetch: fetchFake, env: { POLICY_DRIFT_TOKEN: 'abc' } },
    );
    expect(errors).toEqual([]);
    expect(docs[0].clauses[0].id).toBe('art-1');
    expect(seen?.init?.method).toBe('POST');
    expect(seen?.init?.body).toBe('{"q":1}');
    expect(seen?.init?.headers).toMatchObject({ 'content-type': 'application/json', Authorization: 'Bearer abc' });
  });

  it('converts http-json html format with htmlToText', async () => {
    const fetchFake = (async () => reply({ b: '<h2>제1조 (가)</h2><p>본문</p>' })) as unknown as typeof fetch;
    const { docs } = await fetchPolicies(
      cfg({ type: 'terms', source: 'http-json', url: 'https://a.test', format: 'html', body: {}, pick: 'b' }),
      dir,
      { fetch: fetchFake },
    );
    expect(docs[0].text).toBe('## 제1조 (가)\n본문');
  });

  it('reports a pick path that is missing or not a string', async () => {
    const fetchFake = (async () => reply({ data: { n: 5 } })) as unknown as typeof fetch;
    const src = (pick: string): PolicySource =>
      ({ type: 'terms', source: 'http-json', url: 'https://a.test', format: 'markdown', body: {}, pick });
    const { docs, errors } = await fetchPolicies(cfg(src('data.missing.0'), src('data.n')), dir, { fetch: fetchFake });
    expect(docs).toEqual([]);
    expect(errors.map((e) => e.message)).toEqual(['pick path not found: data.missing.0', 'pick path not found: data.n']);
  });

  it('names the unset env variable and does not call fetch', async () => {
    let called = false;
    const fetchFake = (async () => { called = true; return reply('x'); }) as unknown as typeof fetch;
    const { docs, errors } = await fetchPolicies(
      cfg({ type: 'privacy', source: 'url', url: 'https://a.test', headers: { A: '${POLICY_DRIFT_TOKEN}' } }),
      dir,
      { fetch: fetchFake, env: {} },
    );
    expect(docs).toEqual([]);
    expect(errors[0].message).toBe('missing env: POLICY_DRIFT_TOKEN');
    expect(called).toBe(false);
  });

  it('turns a network exception into an error message', async () => {
    const fetchFake = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const { errors } = await fetchPolicies(cfg({ type: 'privacy', source: 'url', url: 'https://a.test' }), dir, { fetch: fetchFake });
    expect(errors).toEqual([{ type: 'privacy', origin: 'https://a.test', message: 'connect ECONNREFUSED' }]);
  });
});

describe('splitClauses heading shapes (item 1)', () => {
  const ids = (t: string) => splitClauses(t).map((c) => c.id);
  it.each([
    ['bold', '**제1조 (목적)**\n본문\n**제2조 (정의)**\n본문'],
    ['underscore bold', '__제1조 (목적)__\n본문\n__제2조 (정의)__\n본문'],
    ['lenticular brackets', '제1조【목적】\n본문\n제2조【정의】\n본문'],
    ['square brackets', '제1조 [목적]\n본문\n제2조 [정의]\n본문'],
    ['title and body on one line', '제1조(목적) 이 약관은 지어낸 서비스의 조건을 정합니다.\n제2조(정의) 용어는 다음과 같습니다.'],
  ])('recognizes %s', (_, text) => {
    expect(ids(text)).toEqual(['art-1', 'art-2']);
  });
  it('keeps the same-line body in the clause body, not the title', () => {
    const [c] = splitClauses('제1조(목적) 이 약관은 지어낸 서비스의 조건을 정합니다.\n둘째 줄');
    expect(c.title).toBe('제1조(목적)');
    expect(c.body).toBe('이 약관은 지어낸 서비스의 조건을 정합니다.\n둘째 줄');
    expect(c.line).toBe(1);
  });
  it('recognizes an HTML <strong> heading after htmlToText', () => {
    const text = htmlToText('<p><strong>제1조(목적)</strong> 지어낸 목적</p><p><strong>제2조(정의)</strong> 지어낸 정의</p>');
    expect(ids(text)).toEqual(['art-1', 'art-2']);
  });
  it.each(['제2조에 따라 처리합니다.', '제2조의 규정을 따릅니다.', '제2조를 준용합니다.', '제2조에서 정한 바와 같습니다.',
    '제2조 제1항에 따릅니다.', '제2조 및 제3조를 따릅니다.', '제2조(정의)에 따른 용어입니다.'])('treats "%s" as body text', (line) => {
    expect(ids(`## 제1조 (가)\n${line}`)).toEqual(['art-1']);
  });
  it('a heading never turns into a broken reference', async () => {
    const { findBrokenReferences } = await import('../src/crossrefs.js');
    for (const text of ['**제1조 (목적)**\n본문', '제1조【목적】\n본문', '제1조(목적) 이 약관은 제1조에 따라', '<p><strong>제1조(목적)</strong> 본문</p>']) {
      const t = text.startsWith('<') ? htmlToText(text) : text;
      expect(findBrokenReferences({ type: 'terms', origin: 'x', text: t, clauses: splitClauses(t) }), text).toEqual([]);
    }
  });
  it('handles a heading followed by thousands of spaces quickly (item 14)', () => {
    const start = Date.now();
    splitClauses(`## 제목${' '.repeat(50000)}x\n#${' '.repeat(50000)}\n제1조${' '.repeat(50000)}x`);
    expect(Date.now() - start).toBeLessThan(500);
    expect(splitClauses('## 제목 ##\n본문')[0].title).toBe('제목');
    expect(splitClauses('## C# 언어\n본문')[0].title).toBe('C# 언어');
  });
});

describe('fetchPolicies hardening', () => {
  const ok = (async () => reply('<h2>제1조 (가)</h2>')) as unknown as typeof fetch;
  it('only substitutes POLICY_DRIFT_* env vars (item 11)', async () => {
    let called = false;
    const f = (async () => { called = true; return reply('x'); }) as unknown as typeof fetch;
    const { docs, errors } = await fetchPolicies(
      cfg({ type: 'privacy', source: 'url', url: 'https://a.test', headers: { A: '${AWS_SECRET_ACCESS_KEY}' } }),
      dir, { fetch: f, env: { AWS_SECRET_ACCESS_KEY: 'shh' } },
    );
    expect(docs).toEqual([]);
    expect(errors[0].message).toBe('env var not allowed: AWS_SECRET_ACCESS_KEY (only POLICY_DRIFT_* may be used)');
    expect(called).toBe(false);
  });
  it('only fetches https, or http on localhost / 127.0.0.1 (item 11)', async () => {
    const src = (url: string): PolicySource => ({ type: 'privacy', source: 'url', url });
    const { docs, errors } = await fetchPolicies(
      cfg(src('http://evil.test/x'), src('ftp://a.test'), src('http://localhost:3000/p'), src('http://127.0.0.1/p'), src('https://a.test')),
      dir, { fetch: ok },
    );
    expect(errors.map((e) => [e.origin, e.message.startsWith('insecure url')])).toEqual([['http://evil.test/x', true], ['ftp://a.test', true]]);
    expect(docs).toHaveLength(3);
  });
  it('never puts a header value into an error (item 16)', async () => {
    const { errors } = await fetchPolicies(
      cfg({ type: 'privacy', source: 'url', url: 'https://a.test', headers: { Authorization: 'Bearer ${POLICY_DRIFT_TOKEN}' } }),
      dir, { fetch, env: { POLICY_DRIFT_TOKEN: 'sec\nret' } },
    );
    expect(errors[0].message).toBe('invalid header value for Authorization');
  });
  it('reports the network cause and passes a timeout signal (item 16)', async () => {
    let signal: unknown;
    const f = (async (_u: string, init?: RequestInit) => {
      signal = init?.signal;
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND a.test'), { code: 'ENOTFOUND' }) });
    }) as unknown as typeof fetch;
    const { errors } = await fetchPolicies(cfg({ type: 'privacy', source: 'url', url: 'https://a.test' }), dir, { fetch: f });
    expect(errors[0].message).toBe('fetch failed (ENOTFOUND)');
    expect(signal).toBeInstanceOf(AbortSignal);
  });
  it('treats HTML content as HTML even when configured as markdown or a file (item B)', async () => {
    const html = '<!doctype html><h2>제1조 (가)</h2><p>제2조 에 따라</p>';
    const f = (async () => reply({ b: `  ${html}` })) as unknown as typeof fetch;
    const { docs } = await fetchPolicies(
      cfg({ type: 'terms', source: 'http-json', url: 'https://a.test', format: 'markdown', body: {}, pick: 'b' }), dir, { fetch: f },
    );
    expect(docs[0].text).toBe('## 제1조 (가)\n제2조 에 따라');
    const { docs: fromFile } = await fetchPolicies(cfg({ type: 'privacy', source: 'file', path: 'page.html' }), dir);
    expect(fromFile[0].text).toContain('## 제1조 (목적)');
    expect(fromFile[0].text).not.toContain('<h2');
  });
});
