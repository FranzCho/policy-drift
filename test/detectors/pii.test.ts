import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectPii } from '../../src/detectors/pii.js';
import { listRoot } from '../../src/files.js';

const mk = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-pii-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return listRoot('t', dir);
};
const brief = (r: ReturnType<typeof mk>) =>
  detectPii(r).map((p) => `${p.key}|${p.name}|${p.source}|${p.evidence.file}:${p.evidence.line}`);

describe('detectPii', () => {
  it('reads sql, prisma, graphql and form fixtures with 1-based lines, sorted by key', () => {
    const app = listRoot('app', resolve('test/fixtures/app'));
    expect(detectPii(app)).toEqual([
      { key: 'address', name: 'address', source: 'prisma', evidence: { root: 'app', file: 'prisma/schema.prisma', line: 4 } },
      { key: 'birth', name: 'birthDate', source: 'prisma', evidence: { root: 'app', file: 'prisma/schema.prisma', line: 3 } },
      { key: 'email', name: 'email_verified_at', source: 'sql', evidence: { root: 'app', file: 'db/migrations/V1__init.sql', line: 4 } },
      { key: 'email', name: 'contactEmail', source: 'graphql', evidence: { root: 'app', file: 'graphql/schema.graphqls', line: 12 } },
      { key: 'email', name: 'email', source: 'form', evidence: { root: 'app', file: 'src/components/Support.tsx', line: 3 } },
      { key: 'phone', name: 'phone', source: 'sql', evidence: { root: 'app', file: 'db/migrations/V1__init.sql', line: 3 } },
    ]);
  });

  it('excludes email_template_id / emailSubject / email_count style identifiers', () => {
    const root = mk({
      'a.sql': 'CREATE TABLE t (\n  email_template_id INT,\n  email_subject TEXT,\n  email_count INT,\n  email VARCHAR(50)\n);',
    });
    expect(brief(root)).toEqual(['email|email|sql|a.sql:5']);
  });

  it('maps one identifier to one key (email_address -> email, ip_address -> ip), camelCase and Korean', () => {
    const root = mk({
      'a.sql': [
        'ALTER TABLE u ADD COLUMN email_address VARCHAR(10);',
        'ALTER TABLE u ADD COLUMN ip_address VARCHAR(10);',
        'ALTER TABLE u ADD COLUMN `휴대폰번호` VARCHAR(10);',
        'ALTER TABLE u ADD COLUMN account_no VARCHAR(10);',
        'ALTER TABLE u ADD COLUMN card_number VARCHAR(10);',
        'ALTER TABLE u ADD COLUMN resident_no VARCHAR(10);',
        'ALTER TABLE u ADD COLUMN real_name VARCHAR(10);',
        'ALTER TABLE u ADD COLUMN gender VARCHAR(10);',
        '-- ALTER TABLE u ADD COLUMN dob DATE;',
        'ALTER TABLE u ADD COLUMN hotel VARCHAR(10);',
      ].join('\n'),
      'b.graphqls': 'type User {\n  userIpAddress: String\n  birthDay: String\n}\ntype Query {\n  userByEmail(email: String): User\n}\n',
    });
    expect(brief(root)).toEqual([
      'account|account_no|sql|a.sql:4',
      'birth|birthDay|graphql|b.graphqls:3',
      'card|card_number|sql|a.sql:5',
      'email|email_address|sql|a.sql:1',
      'gender|gender|sql|a.sql:8',
      'ip|ip_address|sql|a.sql:2',
      'ip|userIpAddress|graphql|b.graphqls:2',
      'name|real_name|sql|a.sql:7',
      'phone|휴대폰번호|sql|a.sql:3',
      'rrn|resident_no|sql|a.sql:6',
    ]);
  });

  it('reads one-line CREATE TABLE and dedupes by file+line+key', () => {
    const root = mk({ 'a.sql': 'CREATE TABLE t (id INT, email VARCHAR(5), contact_email VARCHAR(5), phone TEXT);' });
    expect(brief(root)).toEqual(['email|email|sql|a.sql:1', 'phone|phone|sql|a.sql:1']);
  });

  it('reads form names in tsx/jsx/html but not test files; prisma only inside model blocks', () => {
    const root = mk({
      'F.tsx': 'const a = <><input name="user[phone]" />\n<meta name="viewport" /></>',
      'g.html': '<input name=\'birth_date\'>',
      'F.test.tsx': '<input name="email" />',
      'schema.prisma': 'enum Kind {\n  EMAIL\n}\nmodel U {\n  // phone String\n  mobile String @unique\n  @@index([mobile])\n}\n',
    });
    expect(brief(root)).toEqual([
      'birth|birth_date|form|g.html:1',
      'phone|user[phone]|form|F.tsx:1',
      'phone|mobile|prisma|schema.prisma:6',
    ]);
  });

  it('returns [] for unrelated files and is deterministic', () => {
    expect(detectPii(mk({ 'README.md': 'email phone', 'a.ts': 'const email = 1;' }))).toEqual([]);
    const app = listRoot('app', resolve('test/fixtures/app'));
    expect(detectPii(app)).toEqual(detectPii(app));
  });
});
