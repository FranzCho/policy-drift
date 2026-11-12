import type { AuditFinding, PolicyDoc } from './types.js';

// ponytail: regex over Korean article numbering ("제N조 제M항"). Unusual styles are not understood:
// "제N조의M" references are skipped, items numbered 가./나. or (1) are not counted, and an other-statute
// prefix is guessed from the word before the reference (…」 / …법 / …법률 / …령 / …규칙). Inheritance of
// that guess only follows plain joiners (, 및 또는 내지 · 제N호 (제목)); "「법」 제17조에 따른 제공과 제18조"
// is read as an internal 제18조.
const NUMBERED = /^ {0,3}(\d+)[.)](?:\s|$)/;
const CIRCLED = /^ {0,3}([①-⑳])/;
const REF = /제\s?(\d+)\s?조(의\s?\d+)?(?:\s*제\s?(\d+)\s?항)?|제\s?(\d+)\s?항/g;
const OTHER_LAW = /(?:」|법|법률|령|규칙)["”'’)）\]]*\s*$/;
const JOIN = /^(?:\s|,|및|또는|내지|·|ㆍ|제\s?\d+\s?호|\([^()]*\))*$/;
const SAME_ARTICLE = /(?:동조|같은\s?조|전조)\s*$/;

/** 항 lines of a clause: ①② when the clause has any, else top-level `N.` / `N)` (which are then 항, not 호). */
const paragraphOf = (body: string): ((line: string) => number | null) => {
  const circled = body.split('\n').some((l) => CIRCLED.test(l));
  return (line) => {
    const c = CIRCLED.exec(line);
    if (c) return c[1].charCodeAt(0) - 0x245f;
    const n = circled ? null : NUMBERED.exec(line);
    return n ? +n[1] : null;
  };
};
const paragraphCount = (body: string): number => {
  const of = paragraphOf(body);
  return body.split('\n').filter((l) => of(l) !== null).length;
};

export function findBrokenReferences(doc: PolicyDoc): AuditFinding[] {
  const out: AuditFinding[] = [];
  const lines = doc.text.split('\n');
  for (const c of doc.clauses) {
    const of = paragraphOf(c.body);
    let para = 0;
    for (const raw of c.body.split('\n')) {
      para = of(raw) ?? para;
      let other = false;
      let prevEnd = -1;
      for (const m of raw.matchAll(REF)) {
        const before = raw.slice(0, m.index);
        other = OTHER_LAW.test(before) || (other && prevEnd >= 0 && JOIN.test(raw.slice(prevEnd, m.index)));
        prevEnd = m.index + m[0].length;
        let broken = false;
        if (other || m[2]) {
          // another statute's article, or 제N조의M: not ours to check
        } else if (m[4]) {
          broken = !SAME_ARTICLE.test(before) && +m[4] === para; // bare 제M항 inside paragraph M of the same clause
        } else {
          const target = doc.clauses.find((x) => x.id === `art-${m[1]}`);
          if (!target) broken = true;
          else if (m[3]) {
            const n = paragraphCount(target.body);
            broken = n > 0 ? n < +m[3] : +m[3] >= 2;
          }
        }
        if (!broken) continue;
        const line = lines.findIndex((l, i) => i >= c.line - 1 && l.includes(raw)) + 1 || c.line;
        out.push({
          kind: 'broken_reference', policy: doc.type, subject: c.title || c.id, detail: m[0],
          evidence: [{ root: doc.origin, file: doc.origin, line }],
        });
      }
    }
  }
  return out;
}
