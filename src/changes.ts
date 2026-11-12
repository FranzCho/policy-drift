import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { listRoot } from './files.js';
import { diffAgainst, extractTree, headSha, isGitRepo, mergeBase } from './git.js';
import { findRuleCandidates } from './numeric.js';
import { scanDataMap } from './scan.js';
import type { Changes, Config, DataMap, RuleCandidate, ScanRoot, Vendor } from './types.js';

export function diffDataMaps(before: DataMap, after: DataMap): { added: DataMap; removed: DataMap } {
  const only = <T>(from: T[], other: T[], key: (t: T) => string): T[] => {
    const seen = new Set(other.map(key));
    return from.filter((t) => !seen.has(key(t)));
  };
  const side = (a: DataMap, b: DataMap): DataMap => ({
    vendors: only(a.vendors, b.vendors, (v) => v.vendorId),
    piiFields: only(a.piiFields, b.piiFields, (p) => `${p.key}\0${p.source}`),
    features: only(a.features, b.features, (f) => f.name),
  });
  return { added: side(after, before), removed: side(before, after) };
}

export async function scanChanges(config: Config | null, cwd: string, vendors: Vendor[], base?: string): Promise<Changes> {
  const skipped: Changes['skipped'] = [];
  const notes: string[] = [];
  const ruleCandidates: RuleCandidate[] = [];
  const beforeRoots: ScanRoot[] = [];
  const afterRoots: ScanRoot[] = [];
  const temps: string[] = [];
  try {
    for (const r of config?.roots ?? [{ path: '.', baseBranch: undefined as string | undefined }]) {
      const now = listRoot(r.path, resolve(cwd, r.path)); // throws "root not found" for a bad path
      if (!isGitRepo(now.dir)) {
        skipped.push({ root: r.path, reason: 'not a git repository' });
        continue;
      }
      const names = base ? [base] : r.baseBranch ? [r.baseBranch] : ['main', 'develop', 'master'];
      let ref: string | null = null;
      let used = '';
      for (const n of names) if ((ref = mergeBase(now.dir, n))) { used = n; break; }
      if (!ref) {
        skipped.push({ root: r.path, reason: `base branch not found: ${names.join(', ')}` });
        continue;
      }
      if (!base && ref === headSha(now.dir)) {
        // Working directly on the base branch: the merge-base is HEAD, so committed changes are invisible.
        const remote = mergeBase(now.dir, `origin/${used}`);
        if (remote && remote !== ref) ref = remote;
        else notes.push(`${r.path}: the base branch "${used}" is the current commit, so changes already committed on it cannot be seen; only uncommitted changes were compared. Pass a base such as a tag or commit (scan_changes base, or audit --diff <base>).`);
      }
      const tree = extractTree(now.dir, ref);
      temps.push(tree);
      beforeRoots.push(listRoot(r.path, tree));
      afterRoots.push(now);
      ruleCandidates.push(...findRuleCandidates(r.path, diffAgainst(now.dir, ref)));
    }
    const { added, removed } = diffDataMaps(scanDataMap(beforeRoots, vendors), scanDataMap(afterRoots, vendors));
    return { added, removed, ruleCandidates, skipped, notes };
  } finally {
    temps.forEach((t) => rmSync(t, { recursive: true, force: true }));
  }
}
