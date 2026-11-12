import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { audit } from './audit.js';
import { scanChanges } from './changes.js';
import { loadConfig } from './config.js';
import { resolveRoots } from './files.js';
import { renderAudit, renderChanges } from './format.js';
import { fetchPolicies } from './policies.js';
import { loadRules, loadVendors } from './registry.js';
import { scanDataMap } from './scan.js';
import { createServer, NO_CONFIG, VERSION } from './server.js';
import type { Config } from './types.js';

type Out = { write(s: string): unknown };
export type Io = { cwd?: string; stdout?: Out; stderr?: Out };

const USAGE = `Usage:
  policy-drift                      start the MCP server on stdio
  policy-drift init                 write an example .policy-drift.json
  policy-drift audit                compare the code with the published documents
  policy-drift audit --diff [base]  compare changes since the base branch (or a tag or commit);
                                    exit 1 if a new service is not mentioned in the privacy policy,
                                    2 if a root could not be compared or no privacy document loaded
Options:
  --lang ko|en   output language (default: from the config)
  -h, --help     show this help
  -v, --version  show the version
`;

const EXAMPLE: Config = {
  language: 'ko',
  jurisdictions: ['kr'],
  roots: [{ path: '.' }],
  policies: [
    { type: 'privacy', source: 'file', path: 'docs/privacy.md' },
    { type: 'terms', source: 'file', path: 'docs/terms.md' },
  ],
};

const INIT_MSG = {
  ko: 'Wrote .policy-drift.json. 아래를 고치세요.\n  policies[].path   게시 중인 개인정보처리방침과 이용약관 파일 경로 (url, http-json 출처도 쓸 수 있음. README 참고)\n  roots[].path      훑을 코드 폴더. baseBranch 를 더하면 변경 비교의 기준 브랜치를 정함\n  jurisdictions     "kr", "gdpr"\n',
  en: 'Wrote .policy-drift.json. Edit these:\n  policies[].path   path to your published privacy policy and terms (url and http-json sources also work; see the README)\n  roots[].path      code folders to scan; add baseBranch to set the base branch for change comparison\n  jurisdictions     "kr", "gdpr"\n',
};

export async function main(argv: string[], io: Io = {}): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const usage = (msg: string): number => (err.write(`${msg}\n\n${USAGE}`), 2);
  try {
    let args;
    try {
      args = parseArgs({
        args: argv, allowPositionals: true,
        options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, diff: { type: 'boolean' }, lang: { type: 'string' } },
      });
    } catch (e) {
      return usage((e as Error).message);
    }
    const { values, positionals } = args;
    if (values.help) {
      out.write(USAGE);
      return 0;
    }
    if (values.version) {
      out.write(`${VERSION}\n`);
      return 0;
    }
    if (values.lang !== undefined && values.lang !== 'ko' && values.lang !== 'en') return usage('--lang must be ko or en');
    const [cmd, base, ...rest] = positionals;
    const known = cmd === undefined || cmd === 'init' || cmd === 'audit';
    const stray = rest.length > 0 || (base !== undefined && !(cmd === 'audit' && values.diff)) || (values.diff && cmd !== 'audit');
    if (!known || stray) return usage(`unknown command or arguments: ${positionals.join(' ') || '--diff'}`);

    if (!cmd) {
      await createServer(cwd).connect(new StdioServerTransport());
      return 0; // the transport keeps the process alive until stdin closes
    }

    if (cmd === 'init') {
      const l = values.lang ?? 'ko';
      try {
        writeFileSync(join(cwd, '.policy-drift.json'), `${JSON.stringify({ ...EXAMPLE, language: l }, null, 2)}\n`, { flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        out.write('.policy-drift.json already exists; left unchanged.\n');
        return 0;
      }
      out.write(INIT_MSG[l]);
      return 0;
    }

    const config = loadConfig(cwd);
    if (!config) {
      err.write(`${NO_CONFIG}\n`);
      return 2;
    }
    const lang = values.lang ?? config.language;
    const vendors = loadVendors();
    const rules = loadRules(config.jurisdictions);
    const { docs, errors } = await fetchPolicies(config, cwd);
    for (const e of errors) err.write(`policy error (${e.type}, ${e.origin}): ${e.message}\n`);
    const hasPrivacy = docs.some((d) => d.type === 'privacy');
    if (!hasPrivacy) err.write('no privacy document was loaded; vendor and required-section checks were skipped\n');

    if (!values.diff) {
      out.write(renderAudit(audit(scanDataMap(resolveRoots(config, cwd), vendors), docs, vendors, rules), lang, cwd));
      return 0;
    }
    const changes = await scanChanges(config, cwd, vendors, base);
    const findings = audit(changes.added, docs, vendors, rules)
      .filter((f) => f.kind === 'vendor_missing' || f.kind === 'vendor_uncertain');
    out.write(renderChanges(changes, lang, findings, cwd));
    if (!hasPrivacy) return 2; // fail closed: without a privacy document a new service cannot be called covered
    if (changes.skipped.length) return 2; // fail closed: a root that could not be compared may hide a new service
    return findings.some((f) => f.kind === 'vendor_missing') ? 1 : 0;
  } catch (e) {
    err.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
