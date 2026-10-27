# Release 1.27.4 evidence

| Status | Tag | Commit | Notes |
| --- | --- | --- | --- |
| Released | `v1.27.4` | `415309d4af692e6b6584ded9ccf128d0732fff5b` | Promotion merge #647; maintenance release |

```text
develop ── #640 docs ── #641 export-limits ── #642 cdp-state ── #646 version sync ──► main (#647)
   └─ tag v1.27.4 on the promotion merge ─► release.yml ─► npm (owner approval)
                                                          ├─ GitHub Release (16 assets, attested)
                                                          └─ winget manifests
main ─► tap dispatch (anvai-labs/homebrew-tap) ─► PR #135 ─► CI approved ─► merged
```

## Publication, verified after the run

Release run [40452224865](https://github.com/anvai-labs/agentbrowser/actions/runs/40452224865), conclusion success.

| Channel | Evidence |
| --- | --- |
| tag-guard | Tag matches package version (1.27.4) — success |
| Binaries | 5 targets compiled + smoke — success |
| Windows bundle + server tarballs | success |
| npm | `@anvailabs/agentbrowser-mcp@1.27.4` live on the registry; owner approved the `npm` environment deployment `7350760307` |
| GitHub Release | `v1.27.4` published (not draft), 16 assets |
| Checksums | `agentbrowser-cli-darwin-arm64` verified against `sha256sums.txt` (`OK`) |
| Attestations | `gh attestation verify` exit 0 on the CLI asset |
| Homebrew tap | Formula bump PR [anvai-labs/homebrew-tap#135](https://github.com/anvai-labs/homebrew-tap/pull/135); agentbrowser audit + install at 1.27.4 green; the failed tap jobs are `dq-kernel` only (pre-existing on tap `main`, unrelated). Merged. |
| Local deployment | `brew upgrade`: 1.27.3_1 → 1.27.4_1; service healthy; **the Cedar policy file survived the upgrade untouched** (same document hash `e16861bc…` before and after) — the durability design from 1.27.3's follow-through holding in practice |

## What shipped

- **#642** — `observe()` keeps sibling CDP domain state alive: the disclosure scan holds one
  lazily minted, page-lifetime CDP session instead of minting and detaching per call (detach
  tears down per-target domain state, including foreign WebAuthn virtual-authenticator
  environments — observed blocking 15 Anvai Identity browser harnesses).
- **#641** — `policy export` carries `AGENTBROWSER_MAX_RESPONSE_BYTES` in `limits.maxResponseBytes`
  (parser shared into `@agentbrowser/policy-engine`).
- **#640** — docs: the Cedar-policy migration example's Homebrew step teaches the durable
  mechanisms (formula `AGENTBROWSER_POLICY_FILE` stanza + `~/.homebrew/services/formula.env`).

## Upgrade notes

See the CHANGELOG's `[1.27.4]` section. No behavior disclosures beyond the two fixes.
