# Release 1.18.0 delivery record

Status: **released 2026-10-15.** Tag `v1.18.0` on main `9406045` (promotion PR #471, merge commit);
release run 38741154969 (13:15–13:26 UTC), **all 14 jobs green** — tag guard (version and the new
main-ancestry check), five MCP binaries, four server targets, the Windows bundle, npm, checksums and
the GitHub Release, winget; 16 assets on the GitHub Release (5 MCP binaries, 5 CLI binaries, 4 server tarballs, the Windows zip, `sha256sums.txt`); `@anvailabs/agentbrowser-mcp@1.18.0` on npm
(`sha512-TO/rizl3TPTGHcaUZDXDzyqTM0DvraJlxwZv0OG6i5tAtPwstNpBM8Rw+kn6zsIyKa+JMz/TpRdxXMgl3D38lg==`). Main back-synced into develop by #483 (`6ca8b71`).
Issue #447 closed (fixed by #454, now released).

## What shipped

- **TD-BROWSER-15, the server policy engine** (ADR-024, Accepted): the egress safety floor, the
  policy-engine seam, the differential oracle, the Cedar schema and generator, the opt-in policy
  file with shadow mode, the policy query surface and its documentation (#444–#458, #460).
- **TD-BROWSER-16, operator login and cookie handoff** (ADR-025, Accepted): the operator
  credential, per-session secret registration, the cookie-domain matcher, the login browser,
  reviewed actions and the lease, the cookie handoff, and its REST/SDK/CLI/MCP surfaces
  (#461–#464, #466, #470, #472).
- **Data-review fixes** (#467): exact-type event paging with gap reporting, fair-share artifact
  eviction, fail-closed tenant ownership; journal retention behind tombstones (#468; the journal is
  not yet wired into the service).
- **Release hardening** (#475): `tag-guard` refuses a tag whose commit is not on `main`. This
  release's own run passed it. The full guarantee also needs the owner's tag ruleset and `npm`
  environment protection (commands in #475).
- **Test integrity** (#479): the login browser's no-disabling-flags test had passed vacuously; it
  now checks the real argv.

## Qualification

- Every PR in the set had an independent adversarial review ending CLEAN, and CI green on its
  exact head before squash-merge to develop; #471 was green (11 contexts) on `148f9bc` before the
  merge to main.
- The CHANGELOG `[1.18.0]` section lists everything on develop at promotion (#480 folded the two
  post-cut entries in).

## Residual

- **Homebrew tap**: not yet updated (the tap still pins 1.17.0; 1.17.1 was never dispatched
  either). Owner action: `gh workflow run update-agentbrowser.yml -R anvai-labs/homebrew-tap -f tag=v1.18.0`,
  then merge the tap PR it opens.
- **R14** closes fully only when the owner applies the `v*` tag ruleset and `npm` environment
  protection from #475.
- Known MCP issue shipped in 1.17 and 1.18.0: clients that validate output (the official
  TypeScript SDK) turn structured tool errors from schema'd tools into `-32602`. The fix (advertised
  schemas accept the error envelope) is in review as #482 for the next release; the owner chose to
  ship 1.18.0 without waiting for it.
