import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pd-test-'));
  made.push(d);
  return d;
};

export const put = (dir: string, file: string, content: string): void => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString().trim();

export const commitAll = (dir: string): void => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c');
};

export const PRIVACY_NO_OPENAI = '# 개인정보 처리방침\n\n## 1. 개인정보의 처리 목적\n회사는 서비스 제공을 위해 개인정보를 처리합니다.\n';

/** Folder with a config, a privacy document and a package.json using the openai SDK. */
export function project(extra: Record<string, string> = {}): string {
  const dir = tmp();
  put(dir, 'package.json', '{\n  "dependencies": {\n    "openai": "^4.0.0"\n  }\n}\n');
  put(dir, 'docs/privacy.md', PRIVACY_NO_OPENAI);
  put(dir, '.policy-drift.json', JSON.stringify({
    language: 'en', jurisdictions: ['kr'], roots: [{ path: '.' }],
    policies: [{ type: 'privacy', source: 'file', path: 'docs/privacy.md' }],
  }));
  for (const [f, c] of Object.entries(extra)) put(dir, f, c);
  return dir;
}
