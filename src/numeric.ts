import { isTestFile } from './detectors/dependencies.js';
import type { RuleCandidate } from './types.js';

// English keywords match whole identifier tokens (snake, camel, kebab, path segments), so "endpoint",
// "breakpoints" and "payload" do not count. Hangul has no token boundaries, so Korean keywords are substrings.
const KEYWORD = /^(?:pay|payments?|paid|refund(?:s|ed|able)?|retry|retries|retried|expire[sd]?|expiry|expiration|withdraw(?:al|als|n|s)?|points?)$/;
const KO_KEYWORDS = ['결제', '환불', '재시도', '만료', '탈퇴', '포인트'];
// docs, snapshots, lock/manifest/version files and stylesheets: their numbers are not business rules
const SKIP = /(\.lockb?|-lock\.(json|ya?ml)|\.mdx?|\.snap|\.toml|\.gradle(\.kts)?|\.(css|scss|sass|less))$|(^|\/)(package\.json|gradle\.properties)$/;
// A digit run counts only as a standalone literal: not after a letter (v2) or after "letter-" (p-4, gap-8); "= -1" counts.
const NUM = /(?<![\w$]|[\w$]-)\d[\d_]*(?:\.\d+)?/g;
// ponytail: class strings and `prop: N<unit>` are blanked before comparing; a style object without units
// (`{ padding: 8 }`) still counts. Upgrade path: skip whole style blocks by AST.
const CLASS_ATTR = /\bclass(?:Name)?\s*=\s*(?:"[^"]*"|'[^']*'|\{`[^`]*`\})/g;
const CSS_UNIT = /([A-Za-z-]+\s*:\s*['"]?)-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|pt|%)(?![A-Za-z0-9])/g;

const strip = (s: string) => s.replace(CLASS_ATTR, 'class=""').replace(CSS_UNIT, '$1#');
const mask = (s: string) => s.replace(NUM, '#');

function keywordOf(haystack: string): string | undefined {
  const tokens = haystack
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return tokens.find((t) => KEYWORD.test(t)) ?? KO_KEYWORDS.find((k) => haystack.includes(k));
}

export function findRuleCandidates(rootLabel: string, diff: string): RuleCandidate[] {
  const out: RuleCandidate[] = [];
  let file: string | null = null;
  let inHunk = false;
  let minus: string[] = [];
  let plus: { text: string; line: number }[] = [];
  let line = 0;

  const flush = () => {
    if (file && !SKIP.test(file) && !isTestFile(file)) {
      const used = new Set<number>();
      for (const p of plus) {
        // An unchanged line consumes its twin; otherwise pair with the first unused line of the same shape.
        // ponytail: O(minus × plus) per hunk; index minus lines by mask if huge generated hunks get slow.
        const same = minus.findIndex((m, i) => !used.has(i) && m === p.text);
        if (same >= 0) {
          used.add(same);
          continue;
        }
        const a = strip(p.text);
        const i = minus.findIndex((m, j) => !used.has(j) && mask(strip(m)) === mask(a));
        if (i < 0) continue;
        used.add(i);
        const b = strip(minus[i]);
        if (b === a) continue; // only class strings or CSS units changed
        const text = p.text.trim();
        const keyword = keywordOf(`${file}\n${text}`);
        if (!keyword) continue;
        const [nb, na] = [b.match(NUM) ?? [], a.match(NUM) ?? []];
        nb.forEach((before, n) => {
          if (before !== na[n]) out.push({ root: rootLabel, file: file!, line: p.line, before, after: na[n], keyword, text });
        });
      }
    }
    minus = [];
    plus = [];
  };

  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      flush();
      inHunk = false;
      file = null;
    } else if (l.startsWith('@@')) {
      flush();
      inHunk = true;
      line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    } else if (!inHunk) {
      if (l.startsWith('+++ ')) {
        const p = l.slice(4).replace(/\t.*$/, '');
        file = p.startsWith('b/') ? p.slice(2) : null; // "/dev/null" = deleted file
      }
    } else if (l.startsWith('-')) {
      minus.push(l.slice(1));
    } else if (l.startsWith('+')) {
      plus.push({ text: l.slice(1), line: line++ });
    }
  }
  flush();
  return out.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line)); // stable: same-line numbers keep their order
}
