export type Evidence = { root: string; file: string; line: number };
export type ScanRoot = { label: string; dir: string; files: string[] }; // files: dir 기준 상대경로, 정렬됨

export type Vendor = {
  id: string; names: string[]; parent?: string; country: string; purpose: string;
  packages: string[]; domains: string[]; trackers?: string[]; source: string;
  /** Names that are also ordinary words (Resend, Meta): matched case-sensitively as whole words only. */
  strictNames?: string[];
};
export type VendorHit = { vendorId: string; via: 'dependency' | 'host' | 'tracker'; evidence: Evidence[] };
export type PiiField = { key: string; name: string; source: 'sql' | 'prisma' | 'graphql' | 'form'; evidence: Evidence };
export type Feature = { name: string; evidence: Evidence };
export type DataMap = { vendors: VendorHit[]; piiFields: PiiField[]; features: Feature[] };

export type PolicyType = 'privacy' | 'terms';
export type Clause = { id: string; title: string; body: string; line: number };
export type PolicyDoc = { type: PolicyType; origin: string; text: string; clauses: Clause[] };
export type PolicyError = { type: PolicyType; origin: string; message: string };

export type PolicySource =
  | { type: PolicyType; source: 'file'; path: string }
  | { type: PolicyType; source: 'url'; url: string; headers?: Record<string, string> }
  | { type: PolicyType; source: 'http-json'; url: string; format: 'markdown' | 'html';
      headers?: Record<string, string>; body: unknown; pick: string };
export type Config = {
  language: 'ko' | 'en'; jurisdictions: string[];
  roots: { path: string; baseBranch?: string }[]; policies: PolicySource[];
};

export type RequiredSection = { id: string; title: string; keywords: string[]; basis: string };
export type RulePack = {
  jurisdiction: string; sections: RequiredSection[]; crossBorderKeywords: string[];
  notice: { defaultDays: number; adverseDays: number };
};

export type RuleCandidate = { root: string; file: string; line: number; before: string; after: string; keyword: string; text: string };
export type Changes = {
  added: DataMap; removed: DataMap; ruleCandidates: RuleCandidate[];
  skipped: { root: string; reason: string }[];
  /** Limits of the comparison the host AI must mention (e.g. the base branch is the current commit). */
  notes: string[];
};

export type FindingKind = 'vendor_missing' | 'vendor_uncertain' | 'section_missing_candidate'
  | 'cross_border_missing_candidate' | 'broken_reference';
export type AuditFinding = { kind: FindingKind; policy: PolicyType; subject: string; detail: string; evidence: Evidence[] };
