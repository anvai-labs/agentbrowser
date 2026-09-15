# Firefox and application-seam validation

Implemented on the isolated `feat/delegated-coexistence` worktree, following
delegated-session milestone commit `0ec2d7b`. Original checkout and Victor's
companion worktree were left unchanged. No GitHub workflow was dispatched.

## Environment

- macOS arm64, Node 24.11.1, pnpm 9.15.0, locked TypeScript 5.9.3.
- Puppeteer-core 25.11.0 and browser installer 3.2.2 pinned in the lockfile.
- Native installed Firefox 154.0 used for early qualification.
- Downloaded Firefox `stable_155.0.1` used for the consolidated qualification,
  full suite, and final production-tree acceptance.
- Existing Playwright 1.62.1 Chromium used for the parallel UI fixture.

## Red to green

| Regression | Observed red | Green evidence |
| --- | --- | --- |
| Independent adapter contract | New suite failed to import absent implementation | Explicit Firefox/BiDi launch, capability refusal and shutdown-race tests pass |
| Native launch isolation | Installed Firefox exited before BiDi opened | `--no-remote` with an owned temporary profile launches both qualified versions |
| Native control labels | Select label included option text | Native control descendants excluded from associated label text; fill/select/click fixture passes |
| Owned application commands | Contract suite failed to import absent implementation | Version checks, immutable receipts, altered retry conflicts, bounded ledger and lost-response reconciliation pass |
| Chromium quoted names | Status disappeared; dedicated test received undefined name | Existing snapshot parser now handles outer YAML quoting, apostrophes and escaped names; real click and parity fixture pass |
| Truncated/private evidence | Edit beyond captured value prefix was overwritten | Private salted evidence hashes refuse long-value and password changes; test passes without exposing the password in element observations |
| Production dependency isolation | pnpm self-link escaped to checkout | Verified self-link normalization plus strict tree audit passes; arbitrary escapes and hidden Playwright packages still fail |

Both engine paths exercise an actual UI click, an unusable acknowledgment,
explicit reconciliation of the same application operation, direct API execution,
duplicate suppression, stale-human version conflict, and a deliberately broken
UI. The oracle reads application state independently of browser action results.
Browser-native networking can retry a request before a usable response arrives;
application idempotency is needed even without an explicit agent retry. The
lost-acknowledgment fixture truncates a started response to exercise reconciliation.

## Local results

- Full workspace suite with pinned Firefox enabled: **1,475 passed**, 14 existing
  availability skips (Safari 6, Obscura 8). No Firefox tests skipped.
- Focused native Firefox suite: 7 passed, including cookies, keyboard, replaced
  targets, private evidence, PNG bytes, capability refusal and lifecycle cleanup.
- Application contract suite: 5 passed; shared parity runs on both engines.
- Dedicated Chromium quoted-name regression: passed.
- Production-tree audit negative controls: 2 passed.
- `pnpm test:firefox-independence`: passed after the final engine change. An
  isolated production dependency tree with no Playwright performed a native
  Firefox click, produced an independently observed application effect and
  returned real PNG bytes. pnpm emitted a missing development Vite-bin warning;
  the runtime import, tree audit and browser acceptance still passed.
- Workspace build, type checking and lint passed. Lint retains warning-level
  diagnostics, including non-null assertions in tests.
- Documentation links, release-version consistency and release synchronization
  tests passed. The existing eight CI jobs remain; Firefox uses the Test job
  with a pinned cached binary and shared system-library provisioning.

## Limits

This is a local engine qualification and a reusable application fixture, not a
guarded REST/MCP fallback. Firefox policy-bearing sessions are refused. No
hosted containment, complete accessibility tree, frame/shadow-DOM coverage,
popup event parity, durable application receipt storage or new privileged
application tool is claimed. Linux CI and packaged product promotion have not
been run locally. Before service promotion, apply the gates in
[the design](../firefox-and-application-seams.md).
