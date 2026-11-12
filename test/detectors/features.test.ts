import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFeatures } from '../../src/detectors/features.js';
import { listRoot } from '../../src/files.js';

const names = (fs: { name: string }[]) => fs.map((f) => f.name);
const mk = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-feat-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  return listRoot('t', dir);
};

describe('detectFeatures', () => {
  it('lists routes and Query/Mutation fields from the fixture, deduped and sorted', () => {
    const app = listRoot('app', resolve('test/fixtures/app'));
    expect(names(detectFeatures(app))).toEqual(['/', '/challenges', 'challenge', 'challenges', 'createChallenge']);
  });

  it('gives every feature evidence: the page file line 1, or the GraphQL field line (item 12)', () => {
    const root = mk({ 'app/shop/page.tsx': '', 'a.graphqls': 'type User { id: ID }\n\ntype Query {\n  me: User\n}' });
    expect(detectFeatures(root)).toEqual([
      { name: '/shop', evidence: { root: 't', file: 'app/shop/page.tsx', line: 1 } },
      { name: 'me', evidence: { root: 't', file: 'a.graphqls', line: 4 } },
    ]);
  });

  it('reads a 900KB schema quickly (item 13)', () => {
    const big = Array.from({ length: 12000 }, (_, i) => `type T${i} {\n  id: ID!\n  name: String\n  createdAt: String\n}\n`).join('') + 'type Query {\n  last: Int\n}\n';
    const start = Date.now();
    const f = detectFeatures(mk({ 'big.graphqls': big }));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(f).toEqual([{ name: 'last', evidence: { root: 't', file: 'big.graphqls', line: big.split('\n').length - 2 } }]);
  });

  it('strips (group), [dynamic], [...catchall], _private and @slot segments; root page is /', () => {
    const root = mk({
      'app/(marketing)/page.tsx': '',
      'app/(a)/shop/[id]/page.jsx': '',
      'src/app/docs/[...slug]/page.ts': '',
      'app/blog/_drafts/page.js': '',
      'app/dash/@modal/settings/page.tsx': '',
      'app/layout.tsx': '',
      'lib/app/page.tsx': '',
      'pages/index.tsx': '',
    });
    expect(names(detectFeatures(root))).toEqual(['/', '/blog', '/dash/settings', '/docs', '/shop']);
  });

  it('reads fields only directly inside Query/Mutation blocks, including extend type, one-liners, args and comments', () => {
    const root = mk({
      'a.graphqls': [
        '# type Query { ghost: Int }',
        'type Query {',
        '  """doc: not a field"""',
        '  me: User',
        '  users(first: Int = 10, filter: UserFilter): [User!]! @deprecated(reason: "use: people")',
        '}',
        'extend type Mutation { signUp(email: String!): User, signOut: Boolean }',
        'type User { id: ID! name: String }',
        'type Subscription { tick: Int }',
      ].join('\n'),
    });
    expect(names(detectFeatures(root))).toEqual(['me', 'signOut', 'signUp', 'users']);
  });

  it('returns [] for unrelated files and is deterministic', () => {
    expect(detectFeatures(mk({ 'README.md': 'type Query { a: Int }', 'x.ts': '' }))).toEqual([]);
    const app = listRoot('app', resolve('test/fixtures/app'));
    expect(detectFeatures(app)).toEqual(detectFeatures(app));
  });
});
