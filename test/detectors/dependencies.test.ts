import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectDependencies } from '../../src/detectors/dependencies.js';
import { listRoot } from '../../src/files.js';
import type { Vendor } from '../../src/types.js';

const v = (id: string, packages: string[]): Vendor =>
  ({ id, names: [id], country: 'US', purpose: 'x', packages, domains: [], source: 'https://example.com' });
const VENDORS = [
  v('openai', ['openai', 'spring-ai-starter-model-openai']),
  v('anthropic', ['spring-ai-starter-model-anthropic', '@anthropic-ai/sdk']),
  v('channel-io', ['@channel.io/*']),
  v('okhttp', ['com.squareup.okhttp3']),
  v('stripe', ['com.stripe:stripe-java']),
];
const app = listRoot('app', resolve('test/fixtures/app'));
const mk = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-dep-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return listRoot('t', dir);
};
const ev = (file: string, line: number, root = 'app') => ({ root, file, line });

describe('detectDependencies', () => {
  it('finds packages in the fixture app with 1-based lines, sorted by vendorId', () => {
    expect(detectDependencies(app, VENDORS)).toEqual([
      { vendorId: 'anthropic', via: 'dependency', evidence: [ev('build.gradle.kts', 6)] },
      { vendorId: 'channel-io', via: 'dependency', evidence: [ev('package.json', 6)] },
      { vendorId: 'openai', via: 'dependency', evidence: [ev('package.json', 4), ev('requirements.txt', 3)] },
    ]);
  });

  it('matches gradle coordinates in several forms: artifact, group:artifact, group, single quotes, groovy', () => {
    const root = mk({
      'a/build.gradle': "dependencies {\n  implementation 'com.stripe:stripe-java:24.0.0'\n  api(\"com.squareup.okhttp3:okhttp\")\n}\n",
    });
    expect(detectDependencies(root, VENDORS)).toEqual([
      { vendorId: 'okhttp', via: 'dependency', evidence: [ev('a/build.gradle', 3, 't')] },
      { vendorId: 'stripe', via: 'dependency', evidence: [ev('a/build.gradle', 2, 't')] },
    ]);
  });

  it('does not match a package that merely contains the pattern, or a URL in gradle', () => {
    const root = mk({
      'package.json': '{ "dependencies": { "openai-compat": "1", "my-openai": "1" } }',
      'build.gradle': 'maven { url "https://openai/x:y" }\n',
    });
    expect(detectDependencies(root, VENDORS)).toEqual([]);
  });

  it('reads pip names case-insensitively, ignores comments and extras, and reads pyproject', () => {
    const root = mk({
      'requirements.txt': '# openai\n-r base.txt\nOpenAI[extra]==1.0 # pinned\n',
      'pyproject.toml': '[project]\ndescription = "OpenAI wrapper"\ndependencies = [\n  "openai>=1.0",\n]\n',
    });
    expect(detectDependencies(root, VENDORS)).toEqual([
      { vendorId: 'openai', via: 'dependency', evidence: [ev('pyproject.toml', 4, 't'), ev('requirements.txt', 3, 't')] },
    ]);
  });

  it('survives broken package.json', () => {
    expect(detectDependencies(mk({ 'package.json': '{ nope' }), VENDORS)).toEqual([]);
  });

  it('returns [] for a root with unrelated files, and is deterministic', () => {
    expect(detectDependencies(mk({ 'README.md': 'openai', 'notes.txt': 'x' }), VENDORS)).toEqual([]);
    expect(detectDependencies(app, VENDORS)).toEqual(detectDependencies(app, VENDORS));
  });
});
