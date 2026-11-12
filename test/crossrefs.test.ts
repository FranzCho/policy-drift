import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBrokenReferences } from '../src/crossrefs.js';
import { splitClauses } from '../src/policies.js';
import type { PolicyDoc } from '../src/types.js';

const doc = (text: string): PolicyDoc => ({ type: 'terms', origin: 't.md', text, clauses: splitClauses(text) });
const fixture = readFileSync(join(import.meta.dirname, 'fixtures/policies/terms.md'), 'utf8');

describe('findBrokenReferences', () => {
  it('reports exactly the three planted errors in terms.md', () => {
    const f = findBrokenReferences(doc(fixture));
    expect(f.map((x) => [x.subject, x.detail])).toEqual([
      ['제 3조 (이용계약의 성립)', '제9조'],
      ['제4조 (서비스의 변경)', '제2조 제3항'],
      ['제5조 (회원의 의무)', '제3항'],
    ]);
    expect(f.every((x) => x.kind === 'broken_reference' && x.policy === 'terms')).toBe(true);
    expect(f.map((x) => x.evidence[0].line)).toEqual([15, 18, 23]);
    expect(f[0].evidence[0]).toMatchObject({ root: 't.md', file: 't.md' });
  });

  it('does not report a valid reference or a reference to the own article', () => {
    expect(findBrokenReferences(doc('## 제1조 (가)\n제1조에 따라\n## 제2조 (나)\n1. a\n2. b\n제2조 제2항에 따라 및 제1조 제5항'))
      .map((x) => x.detail)).toEqual(['제1조 제5항']);
  });

  it('ignores references to other statutes', () => {
    const text = [
      '## 제1조 (가)',
      '「개인정보 보호법」 제17조에 따라, 「정보통신망법」 제50조 제3항에 따라',
      '정보통신망 이용촉진 및 정보보호 등에 관한 법률 제35조, 같은 법 제9조 제4항',
      '개인정보 보호법 시행령 제30조 및 전자금융거래법률 제99조',
      '「개인정보 보호법」(이하 "법") 제88조',
    ].join('\n');
    expect(findBrokenReferences(doc(text))).toEqual([]);
  });

  it('counts references prefixed by 본 약관 / 이 약관 / 본 조', () => {
    const text = '## 제5조 (가)\n1. a\n2. b\n본 약관 제5조 제4항 각 호, 이 약관 제8조\n';
    expect(findBrokenReferences(doc(text)).map((x) => x.detail)).toEqual(['제5조 제4항', '제8조']);
  });

  it('counts only top-level numbered items (1. 1) ① ; not 4+ spaces or tab)', () => {
    const base = (body: string) => `## 제1조 (가)\n${body}\n## 제2조 (나)\n제1조 제3항\n`;
    expect(findBrokenReferences(doc(base('1. a\n    1. x\n    2. y'))).map((x) => x.detail)).toEqual(['제1조 제3항']);
    expect(findBrokenReferences(doc(base('1. a\n\t1. x\n\t2. y'))).map((x) => x.detail)).toEqual(['제1조 제3항']);
    expect(findBrokenReferences(doc(base('1) a\n2) b\n3) c')))).toEqual([]);
    expect(findBrokenReferences(doc(base('① a\n② b\n③ c')))).toEqual([]);
    expect(findBrokenReferences(doc(base('   1. a\n   2. b\n   3. c')))).toEqual([]);
  });

  it('allows 제1항 on an article with no list, but not 제2항', () => {
    const base = (ref: string) => `## 제1조 (가)\n본문만 있습니다.\n## 제2조 (나)\n${ref}\n`;
    expect(findBrokenReferences(doc(base('제1조 제1항')))).toEqual([]);
    expect(findBrokenReferences(doc(base('제1조 제2항'))).map((x) => x.detail)).toEqual(['제1조 제2항']);
  });

  it('reports a bare 제M항 only inside paragraph M of the same clause', () => {
    expect(findBrokenReferences(doc('## 제1조 (가)\n1. 제2항에 따른다\n2. 제1항에 따른다\n3. 제3항의 사유\n')).map((x) => x.detail))
      .toEqual(['제3항']);
    expect(findBrokenReferences(doc('## 제1조 (가)\n① 가\n② 나\n③ 제3항의 사유\n')).map((x) => x.detail)).toEqual(['제3항']);
  });

  it('tolerates Korean spacing like 제 5 조 and CRLF', () => {
    const f = findBrokenReferences(doc('## 제 1 조 (가)\r\n제 9 조에 따라\r\n'));
    expect(f.map((x) => x.detail)).toEqual(['제 9 조']);
    expect(f[0].evidence[0].line).toBe(2);
  });

  it('inherits the other-statute classification across enumerations (item 2)', () => {
    const lines = [
      '「개인정보 보호법」 제35조 제4항, 제37조 제2항에 의하여 거절할 수 있습니다.',
      '「개인정보 보호법」 제17조 및 제18조에 해당하는 경우',
      '「개인정보 보호법」 제35조(열람), 제36조(정정·삭제), 제37조(처리정지)에 따른 요구',
      '법 제15조 제1항 제4호, 제17조 제1항',
      '「전자상거래법」 제17조 및 제18조',
      '「지어낸 법」 제40조 내지 제42조 또는 제44조·제45조',
    ];
    expect(findBrokenReferences(doc(`## 제1조 (가)\n${lines.join('\n')}`))).toEqual([]);
  });
  it('stops inheriting at an internal marker or other text (item 2)', () => {
    const text = '## 제1조 (가)\n「지어낸 법」 제17조 및 이 약관 제9조\n「지어낸 법」 제17조에 따라 처리하고 제8조를 따른다.';
    expect(findBrokenReferences(doc(text)).map((x) => x.detail)).toEqual(['제9조', '제8조']);
  });
  it('keeps 항 (①②) and 호 (1. 2.) apart (item 3)', () => {
    const art2 = '## 제2조 (나)\n① 첫째 항\n1. 가\n2. 나\n3. 다\n4. 라\n② 둘째 항\n3. 제3항에 따른 통지를 한다.\n동조 제2항, 같은 조 제2항, 전조 제2항\n';
    const text = `## 제1조 (가)\n본문\n${art2}## 제3조 (다)\n제2조 제5항, 제2조 제2항, 제2조 제3항\n`;
    expect(findBrokenReferences(doc(text)).map((x) => [x.subject, x.detail])).toEqual([
      ['제3조 (다)', '제2조 제5항'], ['제3조 (다)', '제2조 제3항'],
    ]);
  });
});
