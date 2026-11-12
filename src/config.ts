import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import type { Config } from './types.js';

const headers = z.record(z.string(), z.string()).optional();
const type = z.enum(['privacy', 'terms']);

const schema = z.object({
  language: z.enum(['ko', 'en']).default('ko'),
  jurisdictions: z.array(z.string()).default(['kr']),
  roots: z.array(z.object({ path: z.string(), baseBranch: z.string().optional() })).default([{ path: '.' }]),
  policies: z.array(z.discriminatedUnion('source', [
    z.object({ type, source: z.literal('file'), path: z.string() }),
    z.object({ type, source: z.literal('url'), url: z.string(), headers }),
    z.object({
      type, source: z.literal('http-json'), url: z.string(), format: z.enum(['markdown', 'html']),
      headers, body: z.unknown(), pick: z.string(),
    }),
  ])).default([]),
});

export function loadConfig(cwd: string): Config | null {
  const file = join(cwd, '.policy-drift.json');
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`.policy-drift.json is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`.policy-drift.json is invalid: ${issues.join('; ')}`);
  }
  return parsed.data as Config;
}
