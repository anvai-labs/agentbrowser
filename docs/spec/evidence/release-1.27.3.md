# Release 1.27.3 evidence

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| Released | `v1.27.3` | `3e5a011ee21c0c7bf489cafc9c6e1f89b5cb5cb4` | Promotion merge #637; maintenance release |

```text
develop ── #634 fix ── #635 docs ── #636 version sync ──► main (#637)
   └─ tag v1.27.3 on the promotion merge ─► release.yml ─► npm (owner approval)
                                                          ├─ GitHub Release (16 assets, attested)
                                                          └─ winget manifests
main ─► tap dispatch (anvai-labs/homebrew-tap) ─► PR #133 ─► CI approved ─► merged
```

## Publication, verified after the run

Release run [40195655059](https://github.com/anvai-labs/agentbrowser/actions/runs/40195655059), all jobs green.

| Channel | Evidence |
| --- | --- |
| tag-guard | Tag matches package version (1.27.3) — success |
| Binaries | 5 targets compiled + stdio/version/help smoke — success |
| Windows bundle + server tarballs | success (4 server targets) |
| npm | `@anvailabs/agentbrowser-mcp@1.27.3` live on the registry; owner approved the `npm` environment deployment `7313505412` |
| GitHub Release | `v1.27.3` published (not draft), 16 assets |
| Checksums | `agentbrowser-cli-darwin-arm64` verified against `sha256sums.txt` (`OK`) |
| Attestations | `gh attestation verify` exit 0 on the CLI asset |
| winget | Manifests job success |
| Homebrew tap | Formula bump PR [anvai-labs/homebrew-tap#133](https://github.com/anvai-labs/homebrew-tap/pull/133); tap CI's agentbrowser audit + install at 1.27.3 passed; the two failed tap jobs are `dq-kernel` only — pre-existing on tap `main` (run 40190681524), unrelated to this bump. Merged. |
| Local deployment | `brew upgrade`: 1.27.2 → 1.27.3; service healthy on 127.0.0.1:5709 |

## Milestone checks on the released candidate

- The shipped fix verified on the **production brew service**: `navigate` to `https://studio.youtube.com` (Google SSO chain) completes in **0.8 s** and observes semantically — on 1.27.2 the identical call hung the full goto budget and failed `NAVIGATION_TIMEOUT: engine_error`.
- Same commit was CI-green (PR #634: 2,981 tests across engine/cli/api/sdk) and live-smoke-tested before the tag: the smoke ran against a repo-built server on the exact merge head.

## What shipped

- **#634** — egress redirect-terminal fix: fulfilled-302 followers stall in Playwright 1.64's
  interception; navigations now land via renderer `location.replace` to the verified terminal,
  other redirected GETs are served the verified bytes. Plus observe's 504 `ACTION_TIMEOUT`
  mapping, cookie-file import hardening (artifact column, expired-skip with counts,
  coded-error passthrough), SDK per-call timeout headroom.
- **#635** — `docs/policy.md`: worked example retiring the deprecated env vars for a Cedar
  policy file (validated against a live server load).
- **#636** — version sync + CHANGELOG fold (`[1.27.2]` gets its section; `[1.27.3]` records the
  above with the upgrade table and behavior disclosures).

## Upgrade notes

See the CHANGELOG's `[1.27.3]` section. Known follow-ups: the tap formula should carry
`AGENTBROWSER_POLICY_FILE` natively (a plist edit does not survive `brew services`
regeneration — the docs example's durability claim needs that correction), and `policy export`
does not emit `limits`.
