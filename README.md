# mend

mend applies edits that AI models write to a tree of text files, supporting four patch formats: unified diffs (with fuzzy line matching), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. Every edit is validated before any file is changed — on failure, nothing is written.

## Run

```bash
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=auto|unified|search-replace|v4a|json` — patch format (default: auto)
- `--check` — dry run: same output/exit, no files written
- `--strict` — exact line matching only (tier 0)
- `PATCH` — path to patch file, or `-`/omitted for stdin

## make.fun

[![make.fun badge](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank badge](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agusher21/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward badge](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agusher21/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Pool: $100  
Entries close: Mon 24 Nov 2026 21:00 WIB  
Wallet: 7FxQ7pkQeEixkjnk6zeKPFix3KsiZWjp88VMEpTbHS8G

## License

SPDX-License-Identifier: MIT