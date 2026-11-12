import { readText } from '../files.js';
import type { Evidence, ScanRoot, Vendor, VendorHit } from '../types.js';

// Small helpers shared by the other detectors and scan.ts.
export const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);
export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// JS (*.test.*, __tests__), JVM (src/test/, *Test.kt, *Spec.groovy), Python (test_*.py, *_test.py), Go (*_test.go), fixtures.
const TEST_FILE = new RegExp([
  String.raw`\.(?:test|spec)\.[^/]+$`,
  String.raw`(?:^|/)(?:tests?|__tests__|__mocks__|fixtures|e2e)/`,
  String.raw`[^/]Tests?\.(?:kt|java)$`,
  String.raw`[^/]Spec\.(?:kt|groovy)$`,
  String.raw`_test\.(?:py|go)$`,
  String.raw`(?:^|/)test_[^/]*\.py$`,
].join('|'));
export const isTestFile = (file: string): boolean => TEST_FILE.test(file);
export const lines = (text: string): string[] => text.split(/\r?\n/);

export const sortEvidence = (list: Evidence[]): Evidence[] => {
  const seen = new Set<string>();
  return list
    .filter((e) => {
      const k = `${e.root}\0${e.file}\0${e.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => cmp(a.root, b.root) || cmp(a.file, b.file) || cmp(a.line, b.line));
};

export const pushEvidence = (found: Map<string, Evidence[]>, vendorId: string, e: Evidence): void => {
  found.set(vendorId, [...(found.get(vendorId) ?? []), e]);
};

export const toHits = (via: VendorHit['via'], found: Map<string, Evidence[]>): VendorHit[] =>
  [...found]
    .map(([vendorId, ev]) => ({ vendorId, via, evidence: sortEvidence(ev) }))
    .sort((a, b) => cmp(a.vendorId, b.vendorId));

type Cand = { line: number; names: string[] };
const same = (s: string) => s;
const pipName = (s: string) => s.toLowerCase().replace(/[_.]+/g, '-');
const matches = (pattern: string, name: string) =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

function npm(text: string): Cand[] {
  let pkg: Record<string, unknown> | null;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const ls = lines(text);
  return ['dependencies', 'devDependencies'].flatMap((section) => {
    const deps = pkg?.[section];
    if (!deps || typeof deps !== 'object') return [];
    const from = Math.max(0, ls.findIndex((l) => l.includes(`"${section}"`)));
    return Object.keys(deps).map((name) => {
      const re = new RegExp(`"${esc(name)}"\\s*:`);
      const at = ls.findIndex((l, i) => i >= from && re.test(l));
      return { line: Math.max(at, from) + 1, names: [name] };
    });
  });
}

// ponytail: only quoted "group:artifact[:version]" is read. Version catalogs (libs.x.y) and
// coordinates built from variables are not resolved; follow the catalog file if that matters.
const gradle = (text: string): Cand[] =>
  lines(text).map((l, i) => ({
    line: i + 1,
    names: [...l.matchAll(/["']([^"'\s/:]+):([^"'\s/:]+)(?::[^"'\s/]*)?["']/g)].flatMap(([, g, a]) => [a, `${g}:${a}`, g]),
  }));

const pip = (text: string): Cand[] =>
  lines(text).map((l, i) => ({ line: i + 1, names: [/^\s*([A-Za-z0-9][\w.-]*)/.exec(l.replace(/#.*/, ''))?.[1] ?? ''] }));

// Quoted strings that are exactly a requirement ("openai>=1", "openai[x]"), plus poetry-style `openai = "^1"` keys.
const pyproject = (text: string): Cand[] =>
  lines(text).map((l, i) => ({
    line: i + 1,
    names: [
      ...[...l.matchAll(/["']([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@(][^"']*)?["']/g)].map((m) => m[1]),
      /^\s*([A-Za-z0-9][\w.-]*)\s*=/.exec(l)?.[1] ?? '',
    ],
  }));

const reader = (base: string): [(t: string) => Cand[], (s: string) => string] | undefined =>
  base === 'package.json' ? [npm, same]
  : /^build\.gradle(?:\.kts)?$/.test(base) ? [gradle, same]
  : base === 'requirements.txt' ? [pip, pipName]
  : base === 'pyproject.toml' ? [pyproject, pipName]
  : undefined;

export function detectDependencies(root: ScanRoot, vendors: Vendor[]): VendorHit[] {
  const found = new Map<string, Evidence[]>();
  for (const file of root.files) {
    const r = reader(file.split('/').pop()!);
    if (!r) continue;
    const [read, fold] = r;
    for (const { line, names } of read(readText(root, file))) {
      const folded = names.filter(Boolean).map(fold);
      for (const v of vendors) {
        if (v.packages.some((p) => folded.some((n) => matches(fold(p), n)))) {
          pushEvidence(found, v.id, { root: root.label, file, line });
        }
      }
    }
  }
  return toHits('dependency', found);
}
