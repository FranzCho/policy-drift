import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import * as z from 'zod/v4';
import type { RulePack, Vendor } from './types.js';

// Package root: one level up from src/ (vitest) or dist/ (built).
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

const vendorSchema = z.object({
  id: z.string().min(1), names: z.array(z.string()), parent: z.string().optional(),
  country: z.string(), purpose: z.string(), packages: z.array(z.string()), domains: z.array(z.string()),
  trackers: z.array(z.string()).optional(), source: z.string().min(1), strictNames: z.array(z.string()).optional(),
});
const rulePackSchema = z.object({
  jurisdiction: z.string(),
  sections: z.array(z.object({ id: z.string(), title: z.string(), keywords: z.array(z.string()), basis: z.string() })),
  crossBorderKeywords: z.array(z.string()),
  notice: z.object({ defaultDays: z.number(), adverseDays: z.number() }),
});

const readYaml = (file: string): unknown => {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
};

export function loadVendors(dir = join(pkgRoot, 'registry')): Vendor[] {
  const file = join(dir, 'vendors.yaml');
  const raw = readYaml(file);
  const parsed = z.array(vendorSchema).safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const id = Array.isArray(raw) ? (raw[i.path[0] as number] as { id?: unknown } | undefined)?.id : undefined;
      return `${id ? `vendor "${String(id)}"` : 'vendors'} ${i.path.slice(1).join('.') || i.path.join('.')}: ${i.message}`;
    });
    throw new Error(`${file} is invalid: ${issues.join('; ')}`);
  }
  return parsed.data;
}

export function loadRules(jurisdictions: string[], dir = join(pkgRoot, 'rules')): RulePack[] {
  return jurisdictions.map((j) => {
    const file = join(dir, `${j}.yaml`);
    if (!existsSync(file)) throw new Error(`rules not found for jurisdiction "${j}": ${file}`);
    const parsed = rulePackSchema.safeParse(readYaml(file));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new Error(`${file} is invalid: ${issues.join('; ')}`);
    }
    return parsed.data;
  });
}
