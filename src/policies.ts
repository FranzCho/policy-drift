import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Clause, Config, PolicyDoc, PolicyError, PolicySource } from './types.js';

// ponytail: regex, not a parser. Nested or unclosed <nav>/<footer>, tags inside attributes,
// and pages that render client-side are not handled. Upgrade path: a real HTML parser.
// ponytail: text is read as UTF-8 only; an EUC-KR page comes out garbled. Upgrade path: honor the charset header.
// <header> is kept on purpose: article pages often put the clause heading in it.
const codePoint = (s: string, n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : s);
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|nav|footer)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n: string, t: string) => `\n${'#'.repeat(+n)} ${t.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<br\s*\/?>|<\/(?:p|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&middot;/g, '·')
    .replace(/&#(\d{1,7});/g, (s, d: string) => codePoint(s, +d))
    .replace(/&#x([0-9a-f]{1,6});/gi, (s, h: string) => codePoint(s, parseInt(h, 16)))
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" stays "&lt;"
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ponytail: headings are `#` lines or a line that starts with `제N조` followed by (…), 【…】, […] or nothing,
// optionally wrapped in ** or __; text after the bracket stays in the body. `제N조에…`, `제N조 제M항…`,
// `제N조 및…` are body text. `# ` inside code fences, setext headings and "제1장" are not recognised.
// Every pattern here is anchored and has no two adjacent unbounded runs, so long space runs stay linear.
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/;
const ARTICLE_HEAD = /^\s*(제\s?\d+\s?조(?:의\s?\d+)?)\s*(\([^)]*\)|【[^】]*】|\[[^\]]*\])?(.*)$/;
const ARTICLE = /제\s?(\d+)\s?조/;

/** `제N조 (…)` heading → title and the body text that follows it on the same line; null for body text. */
export function articleHeading(line: string): { title: string; rest: string } | null {
  const l = line.replace(/\*\*|__/g, '');
  const m = ARTICLE_HEAD.exec(l);
  if (!m) return null;
  const rest = m[3];
  if (m[2] ? rest !== '' && !/^\s/.test(rest) : rest.trim() !== '') return null;
  return { title: l.slice(0, l.length - rest.length).trim(), rest: rest.trim() };
}

function markdownTitle(raw: string): string {
  let t = raw.trim();
  let e = t.length;
  while (e > 0 && t[e - 1] === '#') e--; // closing #s count only after a space ("C#" keeps its #)
  if (e < t.length && (e === 0 || /\s/.test(t[e - 1]))) t = t.slice(0, e).trim();
  return t.replace(/\*\*/g, '').trim();
}

function clauseId(title: string): string {
  const art = ARTICLE.exec(title);
  if (art) return `art-${art[1]}`;
  const sec = /^(\d+)[.)]/.exec(title);
  if (sec) return `sec-${sec[1]}`;
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
}

export function splitClauses(text: string): Clause[] {
  const lines = text.split(/\r?\n/).map((l) => (/^(import|export)\s/.test(l) ? '' : l));
  const clauses: Clause[] = [];
  const seen = new Map<string, number>();
  let cur: { title: string; line: number; body: string[] } | null = null;
  const preamble: string[] = [];
  const close = () => {
    if (!cur) return;
    const base = clauseId(cur.title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    clauses.push({ id: n === 1 ? base : `${base}-${n}`, title: cur.title, body: cur.body.join('\n').trim(), line: cur.line });
  };
  lines.forEach((l, i) => {
    const h = HEADING.exec(l);
    const art = h ? null : articleHeading(l);
    if (!h && !art) return void (cur ? cur.body.push(l) : preamble.push(l));
    close();
    cur = { title: h ? markdownTitle(h[1]) : art!.title, line: i + 1, body: art?.rest ? [art.rest] : [] };
  });
  close();
  const pre = preamble.join('\n').trim();
  return pre ? [{ id: 'preamble', title: '', body: pre, line: 1 }, ...clauses] : clauses;
}

const pick = (v: unknown, path: string) =>
  path.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), v);

const ENV_PREFIX = 'POLICY_DRIFT_';
const TIMEOUT_MS = 15_000;

function checkUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid url');
  }
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !local) throw new Error('insecure url (only https://, or http://localhost / http://127.0.0.1)');
}

/** Raw text of a source; HTML conversion happens in fetchPolicies. Error messages never carry header values. */
async function load(s: PolicySource, cwd: string, f: typeof fetch, env: NodeJS.ProcessEnv): Promise<string> {
  if (s.source === 'file') {
    const p = resolve(cwd, s.path);
    if (!existsSync(p)) throw new Error(`file not found: ${s.path}`);
    return readFileSync(p, 'utf8');
  }
  checkUrl(s.url);
  const missing = new Set<string>();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.headers ?? {})) {
    headers[k] = v.replace(/\$\{(\w+)\}/g, (_, n: string) => {
      // a hostile repo config must not be able to send, say, AWS_SECRET_ACCESS_KEY to its own URL
      if (!n.startsWith(ENV_PREFIX)) throw new Error(`env var not allowed: ${n} (only ${ENV_PREFIX}* may be used)`);
      if (!env[n]) missing.add(n); // unset and empty both count: never send an empty secret silently
      return env[n] ?? '';
    });
  }
  if (missing.size) throw new Error(`missing env: ${[...missing].join(', ')}`);
  const all = s.source === 'url' ? headers : { 'content-type': 'application/json', ...headers };
  const check = new Headers();
  for (const [k, v] of Object.entries(all)) {
    try {
      check.set(k, v);
    } catch {
      throw new Error(`invalid header value for ${k}`); // the runtime's own message would quote the value
    }
  }
  const init: RequestInit = s.source === 'url'
    ? { headers: all, signal: AbortSignal.timeout(TIMEOUT_MS) }
    : { method: 'POST', headers: all, body: JSON.stringify(s.body), signal: AbortSignal.timeout(TIMEOUT_MS) };
  let res: Response;
  try {
    res = await f(s.url, init);
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(cause ? `${msg} (${cause.code ?? cause.message})` : msg);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (s.source === 'url') return res.text();
  const v = pick(await res.json(), s.pick);
  if (typeof v !== 'string') throw new Error(`pick path not found: ${s.pick}`);
  return v;
}

const isHtml = (s: PolicySource, text: string): boolean =>
  s.source === 'url' || (s.source === 'http-json' && s.format === 'html') ||
  /^<[A-Za-z!]/.test(text.trimStart()) || (s.source === 'file' && /\.html?$/i.test(s.path));

export async function fetchPolicies(
  config: Config, cwd: string, deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<{ docs: PolicyDoc[]; errors: PolicyError[] }> {
  const docs: PolicyDoc[] = [];
  const errors: PolicyError[] = [];
  for (const s of config.policies) {
    const origin = s.source === 'file' ? s.path : s.url;
    try {
      const raw = await load(s, cwd, deps.fetch ?? fetch, deps.env ?? process.env);
      const text = isHtml(s, raw) ? htmlToText(raw) : raw;
      docs.push({ type: s.type, origin, text, clauses: splitClauses(text) });
    } catch (e) {
      errors.push({ type: s.type, origin, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { docs, errors };
}
