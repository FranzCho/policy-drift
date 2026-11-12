import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { audit, vendorName } from './audit.js';
import { loadConfig } from './config.js';
import { resolveRoots } from './files.js';
import { answerFormat, DISCLAIMER } from './format.js';
import { fetchPolicies } from './policies.js';
import { loadRules, loadVendors } from './registry.js';
import { scanChanges } from './changes.js';
import { scanDataMap } from './scan.js';
import type { Config, DataMap, Vendor } from './types.js';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const NO_CONFIG =
  'No .policy-drift.json found. Run `npx policy-drift init` first. / `.policy-drift.json` 이 없습니다. `npx policy-drift init` 을 먼저 실행하세요.';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type Deps = { fetch?: typeof fetch; env?: NodeJS.ProcessEnv };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });
const json = (v: unknown): string => JSON.stringify(v, null, 2);
const lang = (c: Config | null) => c?.language ?? 'ko';

/**
 * Runs a tool body; any Error (bad config, "root not found: ...") becomes a one-line tool error, not a crash.
 * Every result, errors included, ends with the disclaimer in the configured language.
 */
async function run(cwd: string, body: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  let r: ToolResult;
  try {
    r = await body();
  } catch (e) {
    r = text(e instanceof Error ? e.message : String(e), true);
  }
  let l: 'ko' | 'en' = 'ko';
  try { l = lang(loadConfig(cwd)); } catch { /* bad config: already reported by the body */ }
  r.content[0].text += `\n\n${DISCLAIMER[l]}`;
  return r;
}

// Adds company, country and purpose to each vendor hit so the host AI need not look the id up.
function enrich(map: DataMap, vendors: Vendor[]) {
  const byId = new Map(vendors.map((v) => [v.id, v]));
  return {
    ...map,
    vendors: map.vendors.map((h) => {
      const v = byId.get(h.vendorId);
      return { ...h, name: v ? vendorName(v) : h.vendorId, country: v?.country, purpose: v?.purpose };
    }),
  };
}

const withFormat = (body: unknown, c: Config | null, next: string): string =>
  `${json(body)}\n\n== Answer format ==\n${answerFormat(lang(c))}\n\n== Next ==\n${next}`;

export const scanDataMapTool = (cwd: string) => run(cwd, () => {
  const config = loadConfig(cwd);
  const vendors = loadVendors();
  return text(json(enrich(scanDataMap(resolveRoots(config, cwd), vendors), vendors)));
});

export const scanChangesTool = (cwd: string, base?: string) => run(cwd, async () => {
  const config = loadConfig(cwd);
  const vendors = loadVendors();
  const changes = await scanChanges(config, cwd, vendors, base);
  const body = { ...changes, added: enrich(changes.added, vendors), removed: enrich(changes.removed, vendors) };
  const limits = [
    changes.skipped.length ? 'Some roots could not be compared (see `skipped`): you may NOT answer "no impact"; name each skipped root and its reason.' : '',
    changes.notes.length ? 'The comparison has limits (see `notes`): you must mention them in the answer instead of the single "no impact" line.' : '',
  ].filter(Boolean).join(' ');
  const next = [config
    ? `Call get_policies, then get_checklist, then answer in the format above.${limits ? '' : ' If nothing was added, removed or flagged, answer with the single "no impact" line.'}`
    : 'No .policy-drift.json, so documents were not compared. Run `npx policy-drift init` to compare against your published terms and privacy policy.', limits].filter(Boolean).join(' ');
  return text(withFormat(body, config, next));
});

export const getPoliciesTool = (cwd: string, deps: Deps = {}) => run(cwd, async () => {
  const config = loadConfig(cwd);
  if (!config) return text(NO_CONFIG, true);
  const { docs, errors } = await fetchPolicies(config, cwd, deps);
  const body = { docs: docs.map(({ type, origin, clauses }) => ({ type, origin, clauses })), errors };
  return text(json(body), !docs.length && errors.length > 0);
});

export const getChecklistTool = (cwd: string) => run(cwd, () => {
  const config = loadConfig(cwd);
  const rulePacks = loadRules(config?.jurisdictions ?? ['kr']);
  return text(withFormat({ rulePacks }, config, 'Compare these required sections and notice defaults with get_policies, then answer in the format above.'));
});

export const auditTool = (cwd: string, deps: Deps = {}) => run(cwd, async () => {
  const config = loadConfig(cwd);
  if (!config) return text(NO_CONFIG, true);
  const vendors = loadVendors();
  const rules = loadRules(config.jurisdictions);
  const { docs, errors } = await fetchPolicies(config, cwd, deps);
  const notes = docs.some((d) => d.type === 'privacy') ? [] : ['No privacy document was loaded, so vendor and required-section checks were skipped.'];
  const findings = audit(scanDataMap(resolveRoots(config, cwd), vendors), docs, vendors, rules);
  return text(withFormat({ findings, policyErrors: errors, notes }, config,
    'Findings marked candidate or needs-review are not confirmed. Call get_policies to read the clauses and confirm before answering in the format above.'));
});

const PROMPTS = {
  ko: {
    pre: '배포 전 점검입니다. `scan_changes` → `get_policies` → `get_checklist` 순서로 도구를 부르고, 결과에 붙은 답변 형식에 맞춰 약관·개인정보처리방침에서 고칠 곳을 답하세요. 고칠 것이 없으면 없다고 답하세요.',
    full: '전체 점검입니다. `audit` 과 `get_policies` 를 부르세요. 기계 대조 결과에 더해 ① 기능 목록에 있는데 약관에 없는 서비스 ② 주체 표기("회사"와 "당사"가 섞여 쓰이는 것처럼)가 문서 안에서 서로 어긋나는 표현을 찾아, 결과에 붙은 답변 형식에 맞춰 답하세요.',
  },
  en: {
    pre: 'Pre-deploy check. Call `scan_changes`, then `get_policies`, then `get_checklist`, and answer which clauses of the terms and privacy policy need to change, in the answer format attached to the tool results. If nothing needs changing, say so.',
    full: 'Full audit. Call `audit` and `get_policies`. On top of the mechanical comparison, find (1) services in the feature list that the terms do not cover and (2) wording that contradicts itself inside a document, such as mixed names for the operator ("the Company" and "we"), and answer in the answer format attached to the tool results.',
  },
};

export function createServer(cwd: string): McpServer {
  const server = new McpServer({ name: 'policy-drift', version: VERSION });
  const empty = z.object({});
  const reg = (name: string, description: string, cb: () => Promise<ToolResult>) =>
    server.registerTool(name, { description, inputSchema: empty }, cb);

  reg('scan_data_map',
    'Call to see what personal data the code collects and which third-party services it sends data to. Scans the whole codebase (current folder if no config) and returns third-party services (company, country, purpose, evidence file:line), personal-data fields, and a feature list. Facts only; no judgment.',
    () => scanDataMapTool(cwd));
  server.registerTool('scan_changes', {
    description: 'Call before deploy/release when the user asks whether terms of service or privacy policy need updating. Compares the base branch (merge-base) with the working tree and returns newly added/removed third-party services, personal-data fields, features, and changed business-rule numbers, plus `skipped` roots and `notes` on comparison limits; when either is non-empty, "no impact" is not a valid answer. Optional `base` (branch, tag or commit) overrides the base branch.',
    inputSchema: z.object({ base: z.string().optional().describe('Branch, tag or commit to compare against, e.g. "main" or "v1.4.0". Defaults to the configured baseBranch.') }),
  }, ({ base }) => scanChangesTool(cwd, base));
  reg('get_policies',
    'Call after scan_changes or audit to read the published terms of service and privacy policy, split into clauses (id, title, body, line). Use it to quote current wording and to locate the clause that needs to change. Requires .policy-drift.json.',
    () => getPoliciesTool(cwd));
  reg('get_checklist',
    'Call to get the required sections a privacy policy must have for the configured jurisdictions (kr, gdpr), the legal basis for each, default notice periods for changes, and the answer format to use.',
    () => getChecklistTool(cwd));
  reg('audit',
    'Call for a first-time or full check of the published documents against the code. Mechanically compares the code with the privacy policy (services not mentioned, required sections missing, cross-border transfer) and checks both documents for broken article references. Returns findings with evidence; candidates still need a human or AI to confirm. Requires .policy-drift.json.',
    () => auditTool(cwd));

  const prompt = (name: string, description: string, key: 'pre' | 'full') =>
    server.registerPrompt(name, { description }, () => {
      let l: 'ko' | 'en' = 'ko';
      try { l = lang(loadConfig(cwd)); } catch { /* bad config: fall back to ko, tools report the error */ }
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: PROMPTS[l][key] } }] };
    });
  prompt('pre-deploy-check', 'Check whether the code changes since the base branch require updating the terms or privacy policy.', 'pre');
  prompt('full-audit', 'Full comparison of the published terms and privacy policy against the code.', 'full');
  return server;
}
