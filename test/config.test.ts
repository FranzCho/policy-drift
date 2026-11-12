import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pd-config-'));
const write = (dir: string, value: unknown) =>
  writeFileSync(join(dir, '.policy-drift.json'), typeof value === 'string' ? value : JSON.stringify(value));

describe('loadConfig', () => {
  it('returns null when there is no config file', () => {
    expect(loadConfig(tmp())).toBeNull();
  });

  it('fills defaults', () => {
    const dir = tmp();
    write(dir, {});
    expect(loadConfig(dir)).toEqual({
      language: 'ko', jurisdictions: ['kr'], roots: [{ path: '.' }], policies: [],
    });
  });

  it('keeps given values', () => {
    const dir = tmp();
    const given = {
      language: 'en', jurisdictions: ['gdpr'],
      roots: [{ path: '../api', baseBranch: 'develop' }],
      policies: [{ type: 'privacy', source: 'file', path: 'privacy.md' }],
    };
    write(dir, given);
    expect(loadConfig(dir)).toEqual(given);
  });

  it('names the field when roots is a string', () => {
    const dir = tmp();
    write(dir, { roots: '.' });
    expect(() => loadConfig(dir)).toThrow(/roots/);
  });

  it('names the field of a bad policy source', () => {
    const dir = tmp();
    write(dir, { policies: [{ type: 'privacy', source: 'file' }] });
    expect(() => loadConfig(dir)).toThrow(/policies\.0\.path/);
  });

  it('reports invalid JSON', () => {
    const dir = tmp();
    write(dir, '{ nope');
    expect(() => loadConfig(dir)).toThrow(/\.policy-drift\.json/);
  });
});
