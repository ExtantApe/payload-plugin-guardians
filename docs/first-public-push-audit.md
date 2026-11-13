# First public push audit

By the maintainers, 2026-11-10, before the repo's first push. Every commit was scanned.

| Check | Result |
| --- | --- |
| `scripts/leak-check.sh`, with the private terms (local mode) | passed, 28 files, 2026-11-13 |
| `scripts/leak-check.sh` without a terms file (CI mode) | passed, 28 files, 2026-11-13 |
| A second, wider private terms list, matched case-insensitively against every tracked file | 0 hits, 2026-11-13 |
| Ops IDs, private repo paths and private product names in tracked text | removed 2026-11-13 |
| Keys, tokens, passwords, secrets | none; tests use made-up passwords and `test-secret-not-for-production` |
| Email addresses in history | only made-up `@example.com` addresses and the noreply author address |
| Real people's data, personal names | none; git's author field holds the full name, which the owner allows |
| Build output, `node_modules`, `.env`, `.secrets/` | never committed |
| Leak check in CI | yes, `.github/workflows/leak-check.yml` |
| LICENSE | MIT, Copyright (c) 2026 EXTANT APE |
| Tests | 46 pass |
| Keywords | base words, `privacy` and `access-control`, no family tags |
