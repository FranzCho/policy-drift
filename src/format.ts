import { isAbsolute, relative } from 'node:path';
import type { AuditFinding, Changes, Evidence, FindingKind, PolicyType } from './types.js';

type Lang = 'ko' | 'en';

export const DISCLAIMER: Record<Lang, string> = {
  ko: '※ 초안입니다. 법률 자문이 아니며 게시 전에 담당자가 확인해야 합니다.',
  en: '※ Draft only. Not legal advice. Have a responsible person review before publishing.',
};

const KO_FORMAT = `아래 형식으로 답하세요. 이 도구가 모은 사실(코드 근거, 조항 목록, 규칙 묶음)만 근거로 쓰고, 도구 결과에 없는 내용은 지어내지 마세요.

수정이 필요한 곳 N건 · 이용약관 X건, 개인정보처리방침 Y건

1. <문서> <조항> — <한 줄 요약: 표에 한 줄 추가, 숫자 수정 등>
   이유: <코드에서 무엇이 바뀌었는지>
   근거: <파일:줄>
   현재 문구: <get_policies 결과에서 그대로 인용>
   제안 문구: <바꿀 문구>
   확신: 높음 | 확인 필요

공지 기한: <문서의 개정 조항> 기준 N일 전(불리한 변경이면 M일 전)
${DISCLAIMER.ko}

정해진 것:
- 항목마다 조항, 이유, 근거, 현재 문구, 제안 문구, 확신을 모두 적는다.
- 근거는 도구 결과의 evidence(root, file, line)를 \`파일:줄\` 로 적는다. 근거 위치가 없는 항목은 만들지 않는다.
- 현재 문구는 get_policies 의 조항 본문에서 그대로 옮긴다. 조항 문구를 지어내지 않는다. 해당 조항이 문서에 없으면 "(해당 조항 없음)" 이라고 적는다.
- 확신은 \`높음\` 과 \`확인 필요\` 두 가지뿐이다. "회원에게 불리한 변경인가"처럼 해석이 필요한 판단은 항상 \`확인 필요\` 로 적는다.
- audit 의 \`항목 없음 (후보)\`, \`확인 필요\` 는 후보다. get_policies 로 문서를 읽고 실제로 빠졌는지 확정한 뒤 적는다.
- 공지 기한은 문서 안의 개정 조항(예: 약관의 "약관의 변경" 조)에서 먼저 읽는다. 문서에서 찾지 못했을 때만 get_checklist 의 notice 기본값(defaultDays, 불리한 변경은 adverseDays)을 쓰고, 기본값을 썼다고 밝힌다. 기본값이 0 이면 법정 기한이 없다고 적는다.
- 고칠 것이 없고 scan_changes 의 \`skipped\` 와 \`notes\` 가 모두 비어 있으면 다른 말 없이 \`이번 변경은 약관·처리방침에 영향 없음\` 한 줄로 답한다.
- scan_changes 결과의 \`skipped\` 가 비어 있지 않거나 \`notes\` 가 있으면 "영향 없음" 으로 답하지 않는다. 비교하지 못한 root 와 그 이유, notes 의 제약(예: 기준 브랜치가 지금 커밋이라 이미 커밋한 변경은 보지 못함)을 답에 적는다.
- 법을 준수한다거나 위반이 없다고 단정하지 않는다.
- 답의 맨 끝에 면책 문구를 그대로 붙인다: ${DISCLAIMER.ko}`;

const EN_FORMAT = `Answer in the format below. Use only the facts this tool collected (code evidence, clause list, rule packs); do not invent anything that is not in a tool result.

Changes needed: N · Terms X, Privacy policy Y

1. <document> <clause> — <one-line summary: add a row to the table, fix a number, ...>
   Reason: <what changed in the code>
   Evidence: <file:line>
   Current wording: <quoted verbatim from get_policies>
   Proposed wording: <replacement text>
   Confidence: high | needs review

Notice period: N days before (M days if the change is adverse), per <the document's own amendment clause>
${DISCLAIMER.en}

Rules:
- Every item carries clause, reason, evidence, current wording, proposed wording and confidence.
- Cite evidence (root, file, line from the tool result) as \`file:line\`. Do not write an item that has no evidence location.
- Quote current wording verbatim from the clause body returned by get_policies. Never invent clause text. If the clause does not exist in the document, write "(no such clause)".
- Confidence is only \`high\` or \`needs review\`. Judgments that need interpretation, such as "unfavorable to members", are always \`needs review\`.
- \`Section missing (candidate)\` and \`Needs review\` from audit are candidates. Read the document with get_policies and confirm before reporting.
- Read the notice period from the document's own amendment clause first (for example the terms' "changes to these terms" clause). Only if the document has none, use the get_checklist notice default (defaultDays, adverseDays for adverse changes) and say that the default was used. A default of 0 means there is no statutory period.
- If nothing needs changing and scan_changes returned empty \`skipped\` and \`notes\`, answer with the single line \`No impact on the terms or privacy policy from this change\` and nothing else.
- If scan_changes returned a non-empty \`skipped\` or any \`notes\`, do not answer "no impact". Say which roots could not be compared and why, and state the limits in notes (for example: the base branch is the current commit, so committed changes were not seen).
- Never claim legal compliance or that there are no violations.
- End the answer with this disclaimer, unchanged: ${DISCLAIMER.en}`;

export const answerFormat = (lang: Lang): string => (lang === 'en' ? EN_FORMAT : KO_FORMAT);

// East Asian wide characters take two terminal columns.
const wide = (c: number) =>
  (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
  (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6);
export const displayWidth = (s: string): number => [...s].reduce((n, ch) => n + (wide(ch.codePointAt(0)!) ? 2 : 1), 0);

/** Plain padded columns; rows[0] is the header. The last column is not padded. */
export function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => displayWidth(r[i] ?? ''))));
  const line = (r: string[]) =>
    r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i] - displayWidth(c)))).join('  ').trimEnd();
  return [line(rows[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(line)].join('\n');
}

/** `file:line`; a URL origin reads "<url> (line N)"; an absolute path inside `cwd` is shown relative to it. */
export const evidenceText = (e: Evidence, cwd?: string): string => {
  if (/^https?:\/\//.test(e.file)) return `${e.file} (line ${e.line})`;
  let path = e.root === '.' || e.root === e.file ? e.file : `${e.root}/${e.file}`;
  if (cwd && isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) path = rel;
  }
  return `${path}:${e.line}`;
};
const evidenceCell = (list: Evidence[], cwd?: string): string =>
  list.length ? evidenceText(list[0], cwd) + (list.length > 1 ? ` (+${list.length - 1})` : '') : '-';

const L = {
  ko: {
    kind: { vendor_missing: '언급 없음', vendor_uncertain: '확인 필요', section_missing_candidate: '항목 없음 (후보)',
      cross_border_missing_candidate: '항목 없음 (후보)', broken_reference: '참조 오류' } satisfies Record<FindingKind, string>,
    phrase: { vendor_missing: '찾아본 이름:', vendor_uncertain: '모회사만 언급:', section_missing_candidate: '찾아본 키워드:',
      cross_border_missing_candidate: '국외 서비스:', broken_reference: '참조:' } satisfies Record<FindingKind, string>,
    crossBorder: '국외 이전',
    policy: { privacy: '개인정보처리방침', terms: '이용약관' },
    head: ['대상', '상세', '근거'],
    none: '기계 대조에서 발견된 항목이 없습니다.',
    count: (n: number) => `발견 ${n}건`,
    changeHead: ['구분', '종류', '대상', '근거'],
    added: '추가', removed: '삭제', changed: '변경', vendor: '서비스', pii: '개인정보 필드', feature: '기능', rule: '규칙 숫자 후보',
    noChanges: '기준 시점과 비교해 달라진 점이 없습니다.',
    skipped: '비교에서 건너뜀',
    notes: '참고:',
    docCheck: '개인정보처리방침 대조',
  },
  en: {
    kind: { vendor_missing: 'Not mentioned', vendor_uncertain: 'Needs review', section_missing_candidate: 'Section missing (candidate)',
      cross_border_missing_candidate: 'Section missing (candidate)', broken_reference: 'Broken reference' } satisfies Record<FindingKind, string>,
    phrase: { vendor_missing: 'names tried:', vendor_uncertain: 'only parent mentioned:', section_missing_candidate: 'keywords tried:',
      cross_border_missing_candidate: 'foreign services:', broken_reference: 'reference:' } satisfies Record<FindingKind, string>,
    crossBorder: 'Cross-border transfer',
    policy: { privacy: 'Privacy policy', terms: 'Terms' },
    head: ['Subject', 'Detail', 'Evidence'],
    none: 'The mechanical comparison found nothing.',
    count: (n: number) => `${n} finding${n === 1 ? '' : 's'}`,
    changeHead: ['Change', 'Kind', 'Subject', 'Evidence'],
    added: 'Added', removed: 'Removed', changed: 'Changed', vendor: 'Service', pii: 'Personal-data field', feature: 'Feature', rule: 'Rule number candidate',
    noChanges: 'Nothing changed compared with the base.',
    skipped: 'Skipped in comparison',
    notes: 'Notes:',
    docCheck: 'Privacy policy check',
  },
};

const KIND_ORDER: FindingKind[] = ['vendor_missing', 'vendor_uncertain', 'section_missing_candidate', 'cross_border_missing_candidate', 'broken_reference'];
const POLICY_ORDER: PolicyType[] = ['privacy', 'terms'];

/** Grouped by document, then by kind: "<document> (n)", then "  <kind> (n)" and an indented table. */
const findingsTable = (findings: AuditFinding[], lang: Lang, cwd?: string): string => {
  const t = L[lang];
  const blocks: string[] = [];
  for (const policy of POLICY_ORDER) {
    const inDoc = findings.filter((f) => f.policy === policy);
    if (!inDoc.length) continue;
    const parts = [`${t.policy[policy]} (${inDoc.length})`];
    for (const kind of KIND_ORDER) {
      const group = inDoc.filter((f) => f.kind === kind);
      if (!group.length) continue;
      const rows = group.map((f) => {
        const data = f.detail.includes(' | ') ? f.detail.slice(f.detail.indexOf(' | ') + 3) : f.detail;
        return [kind === 'cross_border_missing_candidate' ? t.crossBorder : f.subject, `${t.phrase[kind]} ${data}`, evidenceCell(f.evidence, cwd)];
      });
      parts.push(`  ${t.kind[kind]} (${group.length})\n${table([t.head, ...rows]).replace(/^/gm, '  ')}`);
    }
    blocks.push(parts.join('\n\n'));
  }
  return blocks.join('\n\n');
};

export function renderAudit(findings: AuditFinding[], lang: Lang, cwd?: string): string {
  const t = L[lang];
  const body = findings.length ? `${t.count(findings.length)}\n\n${findingsTable(findings, lang, cwd)}` : t.none;
  return `${body}\n\n${DISCLAIMER[lang]}\n`;
}

export function renderChanges(changes: Changes, lang: Lang, findings: AuditFinding[] = [], cwd?: string): string {
  const t = L[lang];
  const rows: string[][] = [];
  for (const [label, map] of [[t.added, changes.added], [t.removed, changes.removed]] as const) {
    for (const v of map.vendors) rows.push([label, t.vendor, `${v.vendorId} (${v.via})`, evidenceCell(v.evidence, cwd)]);
    for (const p of map.piiFields) rows.push([label, t.pii, `${p.name} [${p.key}, ${p.source}]`, evidenceCell([p.evidence], cwd)]);
    for (const f of map.features) rows.push([label, t.feature, f.name, evidenceCell([f.evidence], cwd)]);
  }
  for (const c of changes.ruleCandidates) {
    rows.push([t.changed, t.rule, `${c.before} -> ${c.after} (${c.keyword})`, evidenceCell([{ root: c.root, file: c.file, line: c.line }], cwd)]);
  }
  const parts = [rows.length ? table([t.changeHead, ...rows]) : t.noChanges];
  if (changes.skipped.length) parts.push(`${t.skipped}:\n${changes.skipped.map((s) => `  ${s.root}: ${s.reason}`).join('\n')}`);
  if (changes.notes.length) parts.push(`${t.notes}\n${changes.notes.map((n) => `  ${n}`).join('\n')}`);
  if (findings.length) parts.push(`${t.docCheck}\n\n${findingsTable(findings, lang, cwd)}`);
  return `${parts.join('\n\n')}\n\n${DISCLAIMER[lang]}\n`;
}
