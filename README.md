# policy-drift

[한국어](README.ko.md)

policy-drift is a local MCP server and CLI that compares your code changes with your published terms of service and privacy policy. It collects the facts (new third-party services, personal-data fields, changed business-rule numbers, broken article references) and hands them to your AI coding tool, which tells you which clause to change, why, and with what wording.

## The problem

A team ships features for a year. Somewhere along the way the code starts sending user input to an LLM API, adds an error tracker, and gets a push-notification SDK. The privacy policy still describes the app as it was at launch, and nobody remembers to update it because nothing in the code review points at the document. policy-drift looks at the code, looks at the document, and tells you where they have drifted apart.

## Install

Claude Code:

```bash
claude mcp add policy-drift -- npx -y policy-drift
```

Cursor and other MCP clients (add to the client's MCP settings):

```json
{
  "mcpServers": {
    "policy-drift": { "command": "npx", "args": ["-y", "policy-drift"] }
  }
}
```

Then, in the folder that publishes your documents:

```bash
npx policy-drift init
```

`init` writes an example `.policy-drift.json`. Point it at your privacy policy and terms (see [Configuration](#configuration)). Without a config file, `scan_data_map` and `scan_changes` still work on the current folder; tools that need the documents ask you to run `init`.

## Ask your agent

- "I'm about to deploy. Do the terms or privacy policy need updating?"
- "Run a full policy audit on this repo."
- "Which third-party services does this code send user data to?"
- "What changed since main that affects our privacy policy?"

The server also registers two prompts, `pre-deploy-check` and `full-audit`, for clients that show prompts. Clients that do not show them still get the same instructions at the end of the `scan_changes` and `audit` results.

## Sample answer

The host AI answers in this format. The format is sent by the server, so the answer looks the same in every client.

```
Changes needed: 2 · Terms 1, Privacy policy 1

1. Privacy policy, 4. Processors — add a row to the table
   Reason: code that sends user activity text to OpenAI was added
   Evidence: services/api/src/ai/summarizer.ts:12
   Current wording: (the table)
   Proposed wording: | OpenAI, L.L.C. | Summarizing user activity | Until the purpose is fulfilled |
   Confidence: high

2. Terms, Article 11 (2) — fix a number
   Reason: the payment retry constant changed from 3 to 5
   Evidence: src/billing/RetryPolicy.kt:18
   Current wording: "Payment will be retried a total of 3 times"
   Proposed wording: "Payment will be retried a total of 5 times"
   Confidence: needs review (this may be adverse to members)

Notice period: 7 days before (30 days if adverse), per Article 3 (3) of the terms
※ Draft only. Not legal advice. Have a responsible person review before publishing.
```

Fixed rules: every item has clause, reason, evidence, current wording, proposed wording and confidence. Confidence is only `high` or `needs review`; judgments such as "adverse to members" are always `needs review`. The notice period is read from the document's own amendment clause first and from the rule pack default otherwise. If nothing needs changing, the answer is one line saying so.

## MCP tools

| Tool | Returns |
|---|---|
| `scan_data_map` | Third-party services (company, country, purpose), personal-data fields, and a feature list for the whole codebase, each with `file:line` evidence |
| `scan_changes` | What was added and removed since the base branch (merge-base with the working tree, uncommitted changes included), plus business-rule number candidates, roots that could not be compared (`skipped`) and comparison limits (`notes`) |
| `get_policies` | Your published documents split into clauses (id, title, body, line) |
| `get_checklist` | Required sections per jurisdiction with their legal basis, default notice periods, and the answer format |
| `audit` | The mechanical comparison described in [How matching decides](#how-matching-decides) |

## CLI

```bash
npx policy-drift                      # start the MCP server on stdio
npx policy-drift init                 # write an example .policy-drift.json (never overwrites)
npx policy-drift audit                # print the audit as a table; exit 0 even with findings
npx policy-drift audit --diff [base]  # compare changes since the base branch
npx policy-drift audit --lang en      # override the config language (ko or en)
```

`audit --diff` exits 1 if a newly added service is not mentioned in the privacy policy, so you can use it in CI. It exits 2 on errors (no config, a root that does not exist, no privacy document to check against) and when a root could not be compared (not a git repository, base branch not found); the skipped roots are printed first. When the base branch is the commit you are on (you work directly on `main`), only uncommitted changes can be seen; the output says so under Notes, and you should pass a tag or commit as `base`. Documents that fail to load are reported on stderr; the other documents are still processed.

## Configuration

`.policy-drift.json` lives in the repository that publishes your documents.

```json
{
  "language": "en",
  "jurisdictions": ["kr", "gdpr"],
  "roots": [
    { "path": ".", "baseBranch": "main" },
    { "path": "../backend", "baseBranch": "main" }
  ],
  "policies": [
    { "type": "privacy", "source": "file", "path": "docs/privacy.md" },
    { "type": "terms", "source": "url", "url": "https://example.com/terms" },
    { "type": "terms", "source": "http-json", "format": "markdown",
      "url": "https://api.example.com/graphql",
      "headers": { "Authorization": "Bearer ${POLICY_DRIFT_TOKEN}" },
      "body": { "query": "query { latestTerms { body } }" },
      "pick": "data.latestTerms.body" }
  ]
}
```

| Field | Meaning |
|---|---|
| `language` | `ko` or `en`. Language of the answer format and CLI output. Default `ko` |
| `jurisdictions` | Rule packs to apply: `kr`, `gdpr`. Default `["kr"]` |
| `roots[].path` | Folders to scan. Default `[{ "path": "." }]`. A root that is not a git repository is scanned but skipped in change comparison |
| `roots[].baseBranch` | Base branch for `scan_changes`. Default: first of `main`, `develop`, `master` that exists (local, then `origin/`) |
| `policies[].type` | `privacy` or `terms` |
| `policies[].source` | `file` (Markdown or MDX), `url` (HTML, body text extracted), or `http-json` (POST, then pick a value by dot path) |
| `headers` | For `url` and `http-json`. `${NAME}` is replaced from the environment, but only for names starting with `POLICY_DRIFT_`; any other name, or an unset variable, is an error that names it. Keep secrets out of the file |
| `pick` | Dot path into the JSON response; numeric segments index arrays |
| `format` | For `http-json`: whether the picked value is `markdown` or `html`. Content that starts with an HTML tag (and `file` paths ending in `.html`) is read as HTML either way |

`url` and `http-json` fetch only `https://` addresses (plus `http://localhost` and `http://127.0.0.1` for local testing), with a 15-second timeout.

There is no source type that runs a shell command, so opening someone else's repository cannot run commands through its config.

## What it detects

All detectors are deterministic: same input, same output. They skip `node_modules`, `.git`, `dist`, `build`, `.next`, `.worktrees` and tool folders (`.claude`, `.cursor`, `.vscode`, `.idea`, `.github`), files over 1MB, files ignored by git, and test code (`*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`, `__mocks__/`, `fixtures/`, `e2e/`, `*Test.kt`, `*Spec.groovy`, `*_test.go`, `test_*.py`, ...) except for dependency manifests.

| Detector | Reads | Finds |
|---|---|---|
| Dependencies | `package.json`, `build.gradle(.kts)`, `requirements.txt`, `pyproject.toml` | Packages in the vendor registry, mapped to company, country and purpose |
| Hosts | URL strings in source and config | Domains in the vendor registry (for example `api.openai.com`) |
| Trackers | Front-end source | Calls such as `gtag(`, `fbq(`, `clarity(` |
| Personal-data fields | SQL migrations, Prisma schema, GraphQL schema, form `name` attributes | A keyword dictionary (English and Korean): email, phone, birth date, address, national ID, bank account, card number, and so on |
| Business-rule numbers | The diff since the base branch | Number constants that changed on lines or paths with payment, refund, retry, expiry, withdrawal or point keywords (English keywords match whole identifier parts, so `endpoint` is not `point`). Manifests and lock files, stylesheets, class strings and CSS units are ignored |
| Feature list | Front-end route folders, top-level GraphQL queries and mutations | Names only, no interpretation |
| Article references | The documents themselves | References to an article or paragraph that does not exist, and a paragraph that refers to itself |

## How matching decides

To keep false positives low, the tool states only what it is sure of.

| Check | Result | Shown as |
|---|---|---|
| Any name of a detected service appears in the privacy policy | Mentioned | not reported |
| The service name is absent but its parent company is named (Firebase absent, Google present) | Uncertain | `Needs review` |
| Neither the name nor the parent appears | Not mentioned | `Not mentioned` |
| No keyword of a required section appears anywhere in the document | Candidate | `Section missing (candidate)` |
| A service headquartered outside Korea is used and no cross-border keyword appears (`kr` pack only) | Candidate | `Section missing (candidate)` |
| An article reference points to a missing article or paragraph | Certain | `Broken reference` |

Names made only of ASCII letters match case-insensitively on word boundaries, so "Sentry" does not match "sentryx". Brand names that are also ordinary words (Resend, Meta, Segment, Clerk, Stripe) match only with that exact capitalization as a whole word, so "we resend the email" is not a mention of Resend. Names in other scripts (for example Korean) match as substrings. Candidates are for a person or the host AI to confirm by reading the document; the CLI shows them as candidates.

## Limitations

- Detection is regex-based, not AST-based. URLs built from variables and dynamic imports are missed.
- Business-rule number matching is a list of candidates. Pairing a changed number with the clause that states it is left to the host AI, and accuracy is lower than for the privacy policy checks.
- Required-section checks look for keywords. A section written in unusual wording is reported as a candidate even though it exists.
- This is not legal advice. The output is a draft for a responsible person to review.
- The Korean statute references in `rules/kr.yaml` were read from a third-party mirror of the statutes, and the PIPC writing guideline could not be opened. Check them against [law.go.kr](https://www.law.go.kr). Items whose basis could not be confirmed say so.
- The GDPR pack is a list of the Article 13 information items, nothing more.
- Article headings are recognized when a line starts with `제N조` followed by `(…)`, `【…】`, `[…]` or nothing (bold or not); `제1장` chapters and other numbering styles are not split. References to `제N조의M` are not checked.
- Pages are read as UTF-8; an EUC-KR page comes out garbled.
- Kakao AlimTalk is in the registry so a policy naming it is understood, but it cannot be detected in code (it is sent through a reseller with no SDK or host of its own).

## Contributing a vendor

Add one entry to `registry/vendors.yaml`. An entry without a `source` URL is rejected.

```yaml
- id: example-analytics
  names: [Example Analytics, "Example Analytics, Inc.", 예제 애널리틱스]  # every name a policy might use
  parent: example                  # optional: id of the parent entry
  country: US                      # ISO 3166 alpha-2 of the legal entity's headquarters
  purpose: Web analytics
  packages: [example-analytics, "@example/*"]   # trailing * is a prefix match
  domains: [collect.example-analytics.com]   # host, or host/path-prefix
  trackers: ["exampleAnalytics("]  # optional browser call patterns
  strictNames: [Example]           # optional: names that are also ordinary words; exact case, whole word only
  source: https://example-analytics.com/legal   # official page that confirms country or entity
```

## Privacy

Everything runs on your machine. policy-drift has no telemetry. The only network requests are to the policy URLs you put in the config, and only over https. Only environment variables named `POLICY_DRIFT_*` are substituted into headers, so a config in a repository you open cannot send your other secrets anywhere, and error messages never include header values. It reads your code and documents and never writes to them; the only file it creates in your project is `.policy-drift.json` from `init`, and only if that file does not exist. `audit --diff` and `scan_changes` extract the base commit's tree into a temporary folder and remove it when done.

## License

MIT
