import { findBrokenReferences } from './crossrefs.js';
import { esc, sortEvidence } from './detectors/dependencies.js';
import type { AuditFinding, DataMap, Evidence, PolicyDoc, RulePack, Vendor } from './types.js';

const ASCII = /^[\x00-\x7f]+$/;

/** ASCII-only names match case-insensitively on word boundaries ("sentryx" is not Sentry); any other name is a substring match. */
export function mentions(text: string, name: string): boolean {
  if (!name) return false;
  if (!ASCII.test(name)) return text.includes(name);
  return new RegExp(`(?<![A-Za-z0-9_])${esc(name)}(?![A-Za-z0-9_])`, 'i').test(text);
}

/** strictNames: case-sensitive whole word, so "Resend" counts and "we resend" does not. */
export function mentionsStrict(text: string, name: string): boolean {
  return !!name && new RegExp(`(?<![A-Za-z0-9_])${esc(name)}(?![A-Za-z0-9_])`).test(text);
}
const named = (text: string, v: Vendor): string | undefined =>
  v.names.find((n) => mentions(text, n)) ?? v.strictNames?.find((n) => mentionsStrict(text, n));
/** Display name: the plain brand (strictNames[0]) when the loose names are only legal entities. */
export const vendorName = (v: Vendor): string => v.strictNames?.[0] ?? v.names[0] ?? v.id;

const KEYWORDS_SHOWN = 3; // the full list and the legal basis are in get_checklist

/** `detail` is "<english phrase> | <data>"; renderAudit localizes the phrase and prints the data. */
export function audit(map: DataMap, docs: PolicyDoc[], vendors: Vendor[], rules: RulePack[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  const privacy = docs.filter((d) => d.type === 'privacy');
  if (privacy.length) {
    const text = privacy.map((d) => d.text).join('\n');
    const lower = text.toLowerCase();
    const docEvidence: Evidence = { root: privacy[0].origin, file: privacy[0].origin, line: 1 }; // "the whole document" as a location
    const byId = new Map(vendors.map((v) => [v.id, v]));
    const evidenceOf = new Map<string, Evidence[]>();
    for (const h of map.vendors) evidenceOf.set(h.vendorId, [...(evidenceOf.get(h.vendorId) ?? []), ...h.evidence]);

    const foreign: { v: Vendor; evidence: Evidence[] }[] = [];
    for (const [id, raw] of evidenceOf) {
      const v = byId.get(id);
      if (!v) continue;
      const evidence = sortEvidence(raw);
      if (v.country !== 'KR') foreign.push({ v, evidence });
      if (named(text, v)) continue;
      const parent = v.parent ? byId.get(v.parent) : undefined;
      const parentName = parent && named(text, parent);
      out.push(parentName
        ? { kind: 'vendor_uncertain', policy: 'privacy', subject: vendorName(v), detail: `only parent company mentioned | ${parentName}`, evidence }
        : { kind: 'vendor_missing', policy: 'privacy', subject: vendorName(v), detail: `not mentioned | ${[...(v.strictNames ?? []), ...v.names].join(', ')}`, evidence });
    }

    for (const pack of rules) {
      for (const s of pack.sections) {
        if (s.keywords.some((k) => lower.includes(k.toLowerCase()))) continue;
        const shown = s.keywords.slice(0, KEYWORDS_SHOWN).join(', ') + (s.keywords.length > KEYWORDS_SHOWN ? ', ...' : '');
        out.push({
          kind: 'section_missing_candidate', policy: 'privacy', subject: s.title, evidence: [docEvidence],
          detail: `no keyword found | ${shown}`,
        });
      }
    }

    const kr = rules.find((r) => r.jurisdiction === 'kr');
    if (kr && foreign.length && !kr.crossBorderKeywords.some((k) => lower.includes(k.toLowerCase()))) {
      out.push({
        kind: 'cross_border_missing_candidate', policy: 'privacy', subject: 'cross-border transfer',
        detail: `no cross-border keyword found | ${foreign.map((f) => `${vendorName(f.v)} (${f.v.country})`).join(', ')}`,
        evidence: [...foreign.map((f) => f.evidence[0]).filter((e): e is Evidence => !!e), docEvidence],
      });
    }
  }
  for (const d of docs) out.push(...findBrokenReferences(d));
  return out;
}
