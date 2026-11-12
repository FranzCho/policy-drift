import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from '../src/format.js';
import { auditTool, createServer, getChecklistTool, getPoliciesTool, NO_CONFIG, scanChangesTool, scanDataMapTool } from '../src/server.js';
import { commitAll, git, project, put, tmp } from './helpers.js';

const body = (r: { content: { text: string }[] }) => r.content[0].text;
const jsonPart = (t: string) => JSON.parse(t.slice(0, t.search(/\n\n(?:== |※)/)));

describe('tool handlers', () => {
  it('scan_data_map works from the folder alone and names the company, country and purpose', async () => {
    const dir = tmp();
    put(dir, 'package.json', '{"dependencies":{"openai":"^4"}}');
    const r = await scanDataMapTool(dir);
    expect(r.isError).toBeUndefined();
    const map = jsonPart(body(r));
    expect(body(r).trimEnd().endsWith(DISCLAIMER.ko)).toBe(true); // item 19
    expect(map.vendors[0]).toMatchObject({ vendorId: 'openai', name: 'OpenAI', country: 'US' });
    expect(map.vendors[0].evidence[0]).toMatchObject({ file: 'package.json', line: 1 });
  });

  it('audit returns findings JSON, the answer format and the next-step hint', async () => {
    const r = await auditTool(project());
    expect(r.isError).toBeUndefined();
    const t = body(r);
    const out = jsonPart(t);
    expect(out.findings.some((f: { kind: string; subject: string }) => f.kind === 'vendor_missing' && f.subject === 'OpenAI')).toBe(true);
    expect(out.policyErrors).toEqual([]);
    expect(t).toContain('== Answer format ==');
    expect(t).toContain(DISCLAIMER.en); // config language is en
    expect(t).toContain('== Next ==');
    expect(t).toContain('get_policies');
  });

  it('audit and get_policies are errors with the init hint when there is no config', async () => {
    const dir = tmp();
    for (const r of [await auditTool(dir), await getPoliciesTool(dir)]) {
      expect(r.isError).toBe(true);
      expect(body(r)).toBe(`${NO_CONFIG}\n\n${DISCLAIMER.ko}`);
      expect(body(r)).toContain('npx policy-drift init');
    }
  });

  it('get_policies returns clauses without the full text, and keeps per-document errors', async () => {
    const dir = project();
    put(dir, '.policy-drift.json', JSON.stringify({
      policies: [{ type: 'privacy', source: 'file', path: 'docs/privacy.md' }, { type: 'terms', source: 'file', path: 'docs/missing.md' }],
    }));
    const r = await getPoliciesTool(dir);
    expect(r.isError).toBeUndefined();
    const out = jsonPart(body(r));
    expect(body(r).trimEnd().endsWith(DISCLAIMER.ko)).toBe(true); // item 19
    expect(out.docs).toHaveLength(1);
    expect(out.docs[0]).not.toHaveProperty('text');
    expect(out.docs[0].clauses[0]).toHaveProperty('body');
    expect(out.errors).toEqual([{ type: 'terms', origin: 'docs/missing.md', message: 'file not found: docs/missing.md' }]);
  });

  it('get_checklist works without a config (default jurisdiction kr) and carries the answer format', async () => {
    const r = await getChecklistTool(tmp());
    expect(r.isError).toBeUndefined();
    const t = body(r);
    expect(jsonPart(t).rulePacks[0].jurisdiction).toBe('kr');
    expect(t).toContain(DISCLAIMER.ko);
  });

  it('scan_changes works without a config (changes only) and says documents were not compared', async () => {
    const r = await scanChangesTool(tmp());
    const t = body(r);
    expect(r.isError).toBeUndefined();
    expect(jsonPart(t).skipped).toEqual([{ root: '.', reason: 'not a git repository' }]);
    expect(t).toContain('documents were not compared');
    expect(t).toMatch(/may NOT answer .*no impact/); // item 5a
  });

  it('a missing root is a one-line error, not a stack trace', async () => {
    const dir = project();
    put(dir, '.policy-drift.json', JSON.stringify({ roots: [{ path: 'nope' }] }));
    for (const r of [await scanDataMapTool(dir), await scanChangesTool(dir), await auditTool(dir)]) {
      expect(r.isError).toBe(true);
      expect(body(r)).toMatch(/^root not found: .*nope\n\n※/);
    }
  });
});

describe('scan_changes guidance (item 5b)', () => {
  it('tells the host AI to mention notes instead of answering no impact', async () => {
    const dir = project();
    git(dir, 'init', '-q', '-b', 'main');
    commitAll(dir);
    const t = body(await scanChangesTool(dir));
    expect(jsonPart(t).notes).toHaveLength(1);
    expect(jsonPart(t).skipped).toEqual([]);
    expect(t).toMatch(/notes.*must mention/i);
  });
});

describe('createServer over an in-memory transport', () => {
  it('answers initialize, lists the five tools and two prompts, and runs the audit tool', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createServer(project());
    await server.connect(a);
    const replies = new Map<number, any>();
    b.onmessage = (m: any) => void (m.id !== undefined && replies.set(m.id, m));
    await b.start();
    const call = async (id: number, method: string, params: unknown) => {
      await b.send({ jsonrpc: '2.0', id, method, params } as never);
      for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 10));
      return replies.get(id);
    };
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(init.result.serverInfo.name).toBe('policy-drift');
    await b.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

    const tools = await call(2, 'tools/list', {});
    expect(tools.result.tools.map((t: { name: string }) => t.name).sort())
      .toEqual(['audit', 'get_checklist', 'get_policies', 'scan_changes', 'scan_data_map']);
    expect(tools.result.tools.find((t: { name: string }) => t.name === 'scan_changes').description).toContain('Call before deploy/release');

    const prompts = await call(3, 'prompts/list', {});
    expect(prompts.result.prompts.map((p: { name: string }) => p.name).sort()).toEqual(['full-audit', 'pre-deploy-check']);
    const prompt = await call(4, 'prompts/get', { name: 'pre-deploy-check' });
    expect(prompt.result.messages[0].content.text).toContain('Pre-deploy check'); // config language is en

    const res = await call(5, 'tools/call', { name: 'audit', arguments: {} });
    expect(res.result.content).toHaveLength(1);
    expect(res.result.content[0].text).toContain('"vendor_missing"');
    expect(res.result.content[0].text).toContain('== Answer format ==');
    await server.close();
  });
});
