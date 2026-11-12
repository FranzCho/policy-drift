import { readText } from '../files.js';
import type { Feature, ScanRoot } from '../types.js';
import { cmp, isTestFile } from './dependencies.js';

export type GqlField = { type: string; name: string; line: number };

// Field names directly inside `type|input|interface X { ... }` blocks (also `extend type`).
// Comments, descriptions and strings are blanked; anything nested in () or {} (arguments, defaults) is masked.
// ponytail: regex, not a parser. Enum values and fields of unions are not read; SDL built in code (gql`` templates) is
// read only if it sits in a .graphql(s) file.
export function graphqlFields(text: string): GqlField[] {
  const clean = text.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, (s) => s.replace(/[^\n]/g, ' '));
  const out: GqlField[] = [];
  const breaks: number[] = []; // offsets of '\n', for a binary-searched line number (one pass, not slice+split per field)
  for (let i = clean.indexOf('\n'); i >= 0; i = clean.indexOf('\n', i + 1)) breaks.push(i);
  const lineAt = (at: number) => {
    let [lo, hi] = [0, breaks.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] < at) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  for (const block of clean.matchAll(/\b(?:type|input|interface)\s+(\w+)[^{}]*\{/g)) {
    const start = block.index + block[0].length;
    let depth = 0;
    const body: string[] = [];
    for (let i = start; i < clean.length; i++) {
      const c = clean[i];
      if (c === '}' && depth === 0) break;
      if (c === '(' || c === '{') depth++;
      body.push(depth === 0 || c === '\n' ? c : ' ');
      if (c === ')' || c === '}') depth--;
    }
    for (const f of body.join('').matchAll(/(?<![\w@])([A-Za-z_]\w*)\s*:/g)) {
      out.push({ type: block[1], name: f[1], line: lineAt(start + f.index) });
    }
  }
  return out;
}

// ponytail: Next app router only (app/ or src/app/ at the root). pages/ router and nested app dirs in a monorepo
// are not seen; point `roots` at the sub-app instead.
function route(file: string): string | null {
  const m = /^(?:src\/)?app\/(?:(.+)\/)?page\.(?:tsx|jsx|ts|js)$/.exec(file);
  if (!m) return null;
  const segs = (m[1] ?? '').split('/').filter((s) => !/^(?:\(.*\)|\[.*\]|_.*|@.*)$/.test(s));
  return `/${segs.join('/')}`;
}

/** Feature names with evidence (page file line 1, or the GraphQL field line); a name seen twice keeps its first evidence. */
export function detectFeatures(root: ScanRoot): Feature[] {
  const out = new Map<string, Feature>();
  const add = (name: string, file: string, line: number) => {
    if (!out.has(name)) out.set(name, { name, evidence: { root: root.label, file, line } });
  };
  for (const file of root.files) {
    const r = route(file);
    if (r) add(r, file, 1);
    if (/\.graphqls?$/.test(file) && !isTestFile(file)) {
      for (const f of graphqlFields(readText(root, file))) {
        if (f.type === 'Query' || f.type === 'Mutation') add(f.name, file, f.line);
      }
    }
  }
  return [...out.values()].sort((a, b) => cmp(a.name, b.name));
}
