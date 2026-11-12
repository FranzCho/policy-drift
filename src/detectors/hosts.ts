import { readText } from '../files.js';
import type { Evidence, ScanRoot, Vendor, VendorHit } from '../types.js';
import { esc, isTestFile, lines, pushEvidence, toHits } from './dependencies.js';

const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|kt|java|py|yml|yaml|json|properties)$|(?:^|\/)\.env[^/]*$/;
const LOCKS = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'gradle.lockfile']);

// A domain counts only as a whole host: nothing hostname-like (or "@", as in an email address) glued
// on the left, and no longer host label on the right. Subdomains (x.channel.io) do match channel.io.
// An entry may carry a path ("googletagmanager.com/gtm.js"): then it is a prefix match from the host on.
// ponytail: URLs assembled at runtime ("https://" + host) and hosts read from env at deploy time are invisible.
export function detectHosts(root: ScanRoot, vendors: Vendor[]): VendorHit[] {
  const doms = vendors.flatMap((v) =>
    v.domains.map((d) => ({
      id: v.id,
      lower: d.toLowerCase(),
      re: new RegExp(`(?<![A-Za-z0-9_@-])${esc(d)}${d.includes('/') ? '' : '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])'}`, 'i'),
    })),
  );
  const found = new Map<string, Evidence[]>();
  for (const file of root.files) {
    if (!SOURCE.test(file) || LOCKS.has(file.split('/').pop()!) || isTestFile(file)) continue;
    const text = readText(root, file);
    const lower = text.toLowerCase();
    const hit = doms.filter((d) => lower.includes(d.lower));
    if (!hit.length) continue;
    lines(text).forEach((l, i) => {
      for (const d of hit) if (d.re.test(l)) pushEvidence(found, d.id, { root: root.label, file, line: i + 1 });
    });
  }
  return toHits('host', found);
}
