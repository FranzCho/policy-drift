import { readText } from '../files.js';
import type { Evidence, ScanRoot, Vendor, VendorHit } from '../types.js';
import { esc, isTestFile, lines, pushEvidence, toHits } from './dependencies.js';

const FRONT = /\.(?:ts|tsx|js|jsx|html)$/;

// ponytail: literal call patterns only. Aliased or wrapped calls (const g = window['gtag']; g(...)) are missed.
export function detectTrackers(root: ScanRoot, vendors: Vendor[]): VendorHit[] {
  const pats = vendors.flatMap((v) =>
    (v.trackers ?? []).map((p) => ({
      id: v.id,
      // `mygtag(` is not `gtag(`; `window.gtag(` is.
      re: new RegExp(`${/^[A-Za-z0-9_$]/.test(p) ? '(?<![A-Za-z0-9_$])' : ''}${esc(p)}`),
    })),
  );
  const found = new Map<string, Evidence[]>();
  for (const file of root.files) {
    if (!FRONT.test(file) || isTestFile(file)) continue;
    lines(readText(root, file)).forEach((l, i) => {
      for (const p of pats) if (p.re.test(l)) pushEvidence(found, p.id, { root: root.label, file, line: i + 1 });
    });
  }
  return toHits('tracker', found);
}
