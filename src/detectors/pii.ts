import { readText } from '../files.js';
import type { PiiField, ScanRoot } from '../types.js';
import { cmp, isTestFile, lines } from './dependencies.js';
import { graphqlFields } from './features.js';

// Matched against the identifier as snake_case tokens (emailVerifiedAt -> email_verified_at).
// A hit is dropped when the next token is template|subject|count (email_template_id). Hangul has no token
// boundaries, so those words match as substrings. Order matters: the first key that hits wins for an
// identifier, so email_address is email and ip_address is ip, not address.
const kw = (ascii: string, ko = ''): RegExp =>
  new RegExp(`(?:^|_)(?:${ascii})(?:$|_(?!(?:template|subject|count)s?(?:_|$)))${ko ? `|${ko}` : ''}`);
const KEYS: [string, RegExp][] = [
  ['email', kw('emails?|e_mail', '이메일')],
  ['ip', kw('ip_addr(?:ess)?')],
  ['phone', kw('phones?|mobiles?|tel(?:ephone)?', '휴대|전화')],
  ['birth', kw('birth(?:day|date)?|dob', '생년')],
  ['rrn', kw('rrn|resident', '주민')],
  ['account', kw('account_(?:no|num|number)|banks?', '계좌')],
  ['card', kw('card_(?:no|num|number)', '카드번호')],
  ['name', kw('real_name|full_name', '성명')],
  ['gender', kw('gender', '성별')],
  ['address', kw('address(?:es)?|addr', '주소')],
];

const snake = (id: string): string =>
  id
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_');

type Ident = { name: string; line: number };

const SQL_TYPE = '(?:n?varchar|n?char|(?:tiny|medium|long)?text|citext|(?:big|small|tiny)?int(?:eger)?|(?:big)?serial|date|datetime|timestamp(?:tz)?|time|bool(?:ean)?|decimal|numeric|float|double|real|jsonb?|blob|bytea|uuid|(?:var)?binary|enum)';
const SQL_COLUMN = new RegExp(`(?:^|[\\s,(])([\\p{L}_][\\p{L}\\p{N}_]*)\\s+${SQL_TYPE}\\b`, 'giu');
// ponytail: a column is `name TYPE` on any line (CREATE TABLE bodies, ADD COLUMN). Types outside the list are missed.
const sql = (text: string): Ident[] =>
  lines(text).flatMap((l, i) =>
    [...l.replace(/--.*$/, '').replace(/[`"[\]]/g, '').matchAll(SQL_COLUMN)].map((m) => ({ name: m[1], line: i + 1 })),
  );

function prisma(text: string): Ident[] {
  let inModel = false;
  const out: Ident[] = [];
  lines(text).forEach((l, i) => {
    if (/^\s*model\s+\w+\s*\{/.test(l)) inModel = true;
    else if (/^\s*\}/.test(l)) inModel = false;
    else if (inModel) {
      const m = /^\s*([A-Za-z_]\w*)\s+[A-Za-z]\w*(?:\[\]|\?)?/.exec(l);
      if (m) out.push({ name: m[1], line: i + 1 });
    }
  });
  return out;
}

// Query / Mutation / Subscription fields are operations (userByEmail), not stored data.
const graphql = (text: string): Ident[] =>
  graphqlFields(text).filter((f) => !/^(?:Query|Mutation|Subscription)$/.test(f.type)).map((f) => ({ name: f.name, line: f.line }));

const form = (text: string): Ident[] =>
  lines(text).flatMap((l, i) => [...l.matchAll(/\bname\s*=\s*["']([^"']+)["']/g)].map((m) => ({ name: m[1], line: i + 1 })));

const source = (file: string): [PiiField['source'], (t: string) => Ident[]] | undefined =>
  /\.sql$/.test(file) ? ['sql', sql]
  : /\.prisma$/.test(file) ? ['prisma', prisma]
  : /\.graphqls?$/.test(file) ? ['graphql', graphql]
  : /\.(?:tsx|jsx|html)$/.test(file) && !isTestFile(file) ? ['form', form]
  : undefined;

export const byPii = (a: PiiField, b: PiiField): number =>
  cmp(a.key, b.key) || cmp(a.evidence.root, b.evidence.root) || cmp(a.evidence.file, b.evidence.file) ||
  cmp(a.evidence.line, b.evidence.line) || cmp(a.name, b.name);

export function detectPii(root: ScanRoot): PiiField[] {
  const out = new Map<string, PiiField>();
  for (const file of root.files) {
    const src = source(file);
    if (!src) continue;
    for (const { name, line } of src[1](readText(root, file))) {
      const s = snake(name);
      const key = KEYS.find(([, re]) => re.test(s))?.[0];
      const id = `${file}\0${line}\0${key}`; // first definition on a line wins
      if (key && !out.has(id)) out.set(id, { key, name, source: src[0], evidence: { root: root.label, file, line } });
    }
  }
  return [...out.values()].sort(byPii);
}
