import { detectDependencies, cmp, sortEvidence } from './detectors/dependencies.js';
import { detectFeatures } from './detectors/features.js';
import { detectHosts } from './detectors/hosts.js';
import { byPii, detectPii } from './detectors/pii.js';
import { detectTrackers } from './detectors/trackers.js';
import type { DataMap, Evidence, Feature, ScanRoot, Vendor, VendorHit } from './types.js';

const byEvidence = (a: Evidence, b: Evidence) => cmp(a.root, b.root) || cmp(a.file, b.file) || cmp(a.line, b.line);

export function scanDataMap(roots: ScanRoot[], vendors: Vendor[]): DataMap {
  const merged = new Map<string, VendorHit>();
  const features = new Map<string, Feature>(); // same name in several roots: keep the smallest evidence
  const piiFields = roots.flatMap((root) => {
    for (const hit of [...detectDependencies(root, vendors), ...detectHosts(root, vendors), ...detectTrackers(root, vendors)]) {
      const k = `${hit.vendorId}\0${hit.via}`;
      const cur = merged.get(k);
      merged.set(k, { ...hit, evidence: [...(cur?.evidence ?? []), ...hit.evidence] });
    }
    for (const f of detectFeatures(root)) {
      const cur = features.get(f.name);
      if (!cur || byEvidence(f.evidence, cur.evidence) < 0) features.set(f.name, f);
    }
    return detectPii(root);
  });
  return {
    vendors: [...merged.values()]
      .map((h) => ({ ...h, evidence: sortEvidence(h.evidence) }))
      .sort((a, b) => cmp(a.vendorId, b.vendorId) || cmp(a.via, b.via)),
    piiFields: piiFields.sort(byPii),
    features: [...features.values()].sort((a, b) => cmp(a.name, b.name)),
  };
}
