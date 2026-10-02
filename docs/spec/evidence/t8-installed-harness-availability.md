# T8 installed-harness availability and schema fidelity (machine record)

Status: qualification record for the installed harnesses on the qualification
Mac, 2026-09-29/30. This is evidence, not milestone completion: the live
model-loop and interactive-approval gates remain with named unblock paths.

## Named installed versions (observed, not assumed)

| Harness | Version | Source | State |
| --- | --- | --- | --- |
| agentbrowser CLI/server | 1.13.0 | brew (`Cellar/agentbrowser/1.13.0`) | healthy on :5709 (no-keys local mode) and :5810 (keyed scratch instance for delegated flows) |
| agentbrowser-mcp | 1.13.0 | `/opt/homebrew/bin/agentbrowser-mcp` | connects; tools/list complete |
| Victor | 0.10.0 | brew formula (`Cellar/victor/0.10.0`) | **blocked** for live provider calls — see F1/F2 |
| Victor (PATH alias) | 0.8.3 | `~/code/.venv/bin/victor` | stale side-install shadowing brew on PATH |
| Codex CLI | 0.157.1 | `/opt/homebrew/bin/codex` (ChatGPT auth) | qualified through tool listing; execution gated on approval policy |
| Claude Code | 2.1.283 | `~/.local/bin/claude` | the executing session itself (CLI path qualified live below) |

## Qualified through the installed CLI (first-class path) — PASS

Full delegated flow against the installed server on a keyed scratch port
(`:5810`, `AGENTBROWSER_API_KEYS`, brew Chromium cache):

1. `session create --tenant t8q --delegated` → session id returned.
2. `page create` → `pg_1_page-0`; `navigate` (positional URL — the 1.13 CLI
   shape) to `https://example.com` → ok.
3. `observe` → revision 2, 7 elements, title "Example Domain"; agent-grant
   `observe` under the delegated token → revision 3 (capability gate passed).
4. Application-surface fence: `application discover` under the **qa**-mode
   grant → `FORBIDDEN: Delegated credential profile does not permit this
   operation`; under a fresh **application**-mode grant → `null` (inert
   surface, no adapters — correct both ways).
5. Operation identity: `act press --operation-id t8-mut-1` → success;
   operator `session operation t8-mut-1` → `completed / dispatched: true`.
6. Grant retirement: `session takeover` → the old delegated token's next call
   → `UNAUTHORIZED`; fresh `prepare-resume → delegate` (mode application)
   issues a new grant whose discover returns null. Take-back: operator
   takeover → page close → session close → zero remaining sessions.
7. **T1 cursor**: the delegate response carried all seven cursor fields
   (`version`, `serviceGeneration`, `bindingGeneration`, `sessionId`,
   `controlEpoch`, `mode`, `profileRevision`) through the installed CLI.

## Codex path — listing fidelity PASS, execution gated on approval policy

`codex mcp add agentbrowser -- /opt/homebrew/bin/agentbrowser-mcp` (global);
`codex mcp get` shows the stdio server enabled. `codex exec` then connected
to the bridge, listed the tools, and **attempted `browser_create` by name** —
the schema reached the model. Execution was refused by Codex's own session
approval policy (`never` in exec mode): "MCP tool call requires approval, but
approval policy is never". The call itself never reached the MCP bridge, so
bridge-side behavior is not implicated.

Unblock options (operator decision; both were declined for autonomous
execution by the session's safety mode): run the same prompt in **interactive
Codex** (chat mode) and approve the tool calls at the prompt, or scope
`mcp_servers.agentbrowser.tool_approval="auto"` to a qualification profile.
No persistent config change was made.

## Victor path — two infrastructure blockers (F1/F2), both pre-tool-call

- **F1 (formula packaging skew, repaired locally):** the brew 0.10.0 formula
  ships an `openai_compat_model_policy.yaml` catalog that includes
  `inferflux` (from #1082, "default provider is now InferFlux") bundled with
  a `sandhi_gateway` binding that predates that provider —
  `provider_descriptor_json('inferflux')` → `unknown provider`, and
  `_load_specs` treats one unknown entry as fatal for the whole registry, so
  **every** victor 0.10.0 command failed at init. Repaired on this machine by
  upgrading the binding inside the Cellar venv
  (`python -m pip install --ignore-installed -U sandhi-gateway`); the durable
  fix is upstream (formula must pin catalog/binding from the same tree, or
  `_load_specs` should skip unknown providers with a warning and fail only
  when the selected profile uses one).
- **F2 (self-signed gateway, no TLS override):** with the binding repaired,
  agent creation succeeds and the loop reaches the provider stream, but
  `https://aiserver1:18788/v1/chat/completions` fails the TLS trust check —
  the gateway presents `CN=aiserver1`, issuer `CN=Sandhi homelab gateway CA`
  (leaf rotated 2026-09-28), and `victor/providers/sandhi_transport.py`
  exposes no CA/insecure-verify option (the rust client rejects where curl
  -k succeeds; gateway confirmed alive, TLS 1.3, 401 with curl -k). Unblock
  requires either a Victor config/transport option to trust a caller-supplied
  CA for a Sandhi gateway, or installing the homelab CA into the trust store
  the client uses — an operator trust decision.

## Footprint (T8 footprint gate, measured 2026-09-29)

Install sizes (`du -sh`, brew Cellar trees) and peak RSS (`/usr/bin/time -l`
max-resident, and `ps rss` for the idle MCP bridge), on the same machine as
every other record in this file. Prompt bytes are a T1 measurement
(`spec-context.mjs` serialized bytes) and are deliberately not mixed in here.

| Measurement | Value |
| --- | --- |
| agentbrowser install (Cellar 1.13.0: CLI + server + MCP) | 337 MB |
| Victor install (Cellar 0.10.0) | 208 MB |
| Application-only control package (src / dist) | 824 KB / 660 KB |
| agentbrowser CLI one-shot (`health`) peak RSS | 47 MB |
| agentbrowser-mcp idle RSS after handshake (16 tools) | 44 MB |
| agentbrowser-server live baseline RSS (Chromium libs loaded, no session) | 415 MB |
| Victor import + sandhi transport peak RSS | 144 MB |
| Victor `--version` peak RSS | 139 MB |

The application-only boundary is visible in the sizes themselves: the
control package that T8's application-only execution requires is under a
megabyte and imports no browser or model SDK, while the browser-carrying
install is three orders of magnitude larger.

## Consequences for the T8 gates

- Slice 2 (schema/result fidelity): **qualified through the installed CLI
  path, Codex listing path, and (2026-10-02) the Codex tool-call path on
  1.15.0 — every acceptance dimension now has an installed-provider run
  (flat, union, enum, nested-object, nested-array inputs; typed
  evidence), see the later 2026-10-02 section.**
  Victor live-loop fidelity remains blocked by the two infrastructure
  facts recorded earlier in this file: the formula catalog/binding skew
  (repaired locally on this machine; the durable fix is upstream) and
  the self-signed Sandhi gateway with no TLS trust override — an
  operator call (the source-level fidelity repair in Victor #1168 is
  unaffected). Note: the "F1/F2" labels used in older entries of this
  file denote THOSE Victor blockers — a namespace collision with the
  delivered foundation refinements that also call themselves F1/F2 in
  [foundation-refinements](../tasks/foundation-refinements.md); blockers
  are named, not labeled, from here on.
- Slice 1 (correlation/cancellation/retirement): qualified at the
  CLI/service level (steps 5–6 above); installed-Victor-level correlation
  remains gated on the same two Victor-loop blockers above.
- Footprint gates (install sizes, RSS): shipped and CI-enforced (peak-RSS
  gates on the compiled binaries; install-size gates on the packaged
  server candidate).
- T1 cursor: delivery qualified through the installed CLI (step 7);
  consumption/retirement semantics remain with the harness sessions.

## 2026-10-01 update (1.14.0 installed): MCP tool-call path qualified

The installed `agentbrowser-mcp` 1.14.0 binary was driven end-to-end against
the installed :5709 service (no-keys local mode); the checks below all pass:
initialize (server reports 1.14.0), tools/list (16 tools — the released set;
`browser_events_replay` is correctly absent, it ships post-1.14.0), then the
full tool-call flow — browser_create → browser_page_create →
browser_navigate (example.com) → browser_observe (elements returned) →
browser_close. This qualifies the MCP-path tool-call fidelity gate for the
installed 1.14.0 harness; the `browser_events_replay` surface qualifies with
the next release. Re-runnable driver: scripted JSON-RPC over stdio against
`/opt/homebrew/bin/agentbrowser-mcp` (driver script is ephemeral at
/tmp/t8-mcp-qualification.mjs; the checks above are the record).

## 2026-10-02 update: gate tightening on Linux numbers

The first footprint-limit tightening pass, made once public-runner Linux
numbers existed (ubuntu-latest CI, 2026-10-02). CI samples vary run to
run, so the record is the observed spread over all 7 linux-x64 runs that
day (bun 1.4.0 pinned), not a point estimate:

| Metric (gate measurement) | darwin-arm64 | linux-x64 observed | Gate |
| --- | --- | --- | --- |
| CLI one-shot peak RSS (`--version`, ps-poll) | 43.5 MB | 37.4–51.9 MB (7 runs) | 75 MB (was 120) |
| MCP bridge idle peak RSS (post-handshake, ps-poll) | 37.7–44.5 MB | 47.4–52.0 MB (7 runs) | 75 MB (was 120) |
| Packaged candidate compressed | 9.2 MB | 7.7 MB | 12 MB (held) |
| Extracted server tree | 55.7 MB | 37.5 MB | 80 MB (held) |

75 MB is 1.44x the worst observed RSS (bridge 52.0 MB, CLI 51.9 MB).
The CLI's ~39% run-to-run spread makes the gate a tripwire for gross
regressions (tens of MB), not a precision instrument; the 10 ms ps-poll
also undersamples true peaks (disclosed in the gate script), so real
headroom is below 1.44x. The install-size gates already sat at
1.30x/1.44x worst-observed, so they held and the RSS gates tightened
instead. Rationale recorded in both gate scripts' headers.

Reconciliation with the 2026-09-29 table above: its 47 MB CLI figure is
a different measurement — the brew-installed 1.13.0 binary running the
`health` one-shot under `/usr/bin/time -l` max-resident — while the gate
polls `--version` on the freshly compiled binary via `ps -o rss=`. Both
are honest; they are not the same number and are not interchangeable.

## 2026-10-02 update (1.15.0 installed): Codex tool-call path qualified

The provider's actual tool-call execution path — the remaining slice-2
gate — is qualified: codex-cli 0.157.1 drove the installed
`agentbrowser-mcp` 1.15.0 binary (brew keg upgraded from 1.14.0; service
on :5709 restarted, `/health` reports 1.15.0) through a real model loop:

`browser_create` → `browser_navigate` (https://example.com) →
`browser_observe` → `browser_close` — all four MCP calls completed, and
the model's ground-truth report matches the page: title "Example
Domain", 1 interactive element (the page's single link). This qualifies
provider-final schema conversion for the exercised subset: flat tool
inputs and an array-of-object observe result round-trip intact through
the model. [Erratum, same day: the unions/enums/nested-autofill
limitation stated in the next sentence was superseded a few hours
later — see the "slice-2 dimensions" section below.] At the time of
this run, the slice-2 acceptance's unions/enums and the nested-autofill
input schema had been exercised only at source level (Victor #1168). A
direct tools/list against
the same installed binary (scripted JSON-RPC over stdio) returns 17
tools including `browser_events_replay` — closing the 2026-10-01
section's commitment for exactly this release.

The approval-policy gate recorded against this path is resolved, with
the resolution itself part of the record: codex `exec` defaults to
`approval_policy = never`, which REFUSES every MCP call ("MCP tool call
requires approval, but approval policy is never" — reproduced once,
then resolved). The scoped fix is `--approve-for-me` (codex's automatic
approval review; implies the workspace-write sandbox and is mutually
exclusive with an explicit `--sandbox` flag) — not
`--dangerously-bypass-approvals-and-sandbox`. Exact invocation:

```
codex exec --ephemeral --ignore-user-config --approve-for-me \
  --skip-git-repo-check \
  -c 'mcp_servers.agentbrowser.command="/opt/homebrew/bin/agentbrowser-mcp"' \
  '<task prompt>'
```

`--ephemeral` persists no session files to disk (auth still reads
`CODEX_HOME`) and `--ignore-user-config` skips the user's
`config.toml`, so the run registers only the agentbrowser server; that
it wrote no repo files is an observation about this run, not a property
of the sandbox. The Claude provider path remains additional
(unrequired) coverage; Victor's live loop remains blocked on the two
facts named above (locally-repaired formula skew; the Sandhi TLS trust
decision, which is an operator call).

## 2026-10-02 update (later): slice-2 dimensions exercised through Codex

The first codex run used flat inputs only. Four further runs the same
day exercise every slice-2 acceptance dimension through the same
installed path (codex-cli 0.157.1 → `agentbrowser-mcp` 1.15.0), all on
public pages, nothing submitted, no files written:

- **Union-typed inputs** — two shapes, stated precisely: the
  model-facing `browser_act` schema is a flattened envelope (an
  `action` string literal plus a nested `target` object, branch
  validation server-side), and the `click` run round-tripped exactly
  that — executed, revision advanced, post-click URL
  `https://www.iana.org/help/example-domains` reported by the model
  from its own follow-up observation. The surface's true `anyOf`
  inputs were carried explicitly in a fourth run: `browser_autofill`
  with `strategy: "native-input"` and `verify: "exact"` — both
  accepted, and the `verify` choice drove the read-back verification
  (receipt `verified: true`, actual value matched).
- **Enum + nested-object input** — `browser_extract` with
  `format: "schema"` and a three-property schema object: the call
  executed and the field-specific "optional field not found" warnings
  prove each property name survived the provider round trip; the
  extractor returned empty `data` with an evidence hash rather than
  fabricating fields.
- **Nested array-of-objects input** — `browser_autofill` on the public
  httpbin test form. First attempt with hardcoded labels failed typed:
  per-field receipts came back (`failed` / `not_attempted` /
  `not_attempted`, `TARGET_NOT_FOUND` on field 0) and the batch
  aborted fail-fast — the failure semantics survive the provider too.
  Second attempt let the model derive labels from its own
  `formControls` observation: three fields, all `verified: true` with
  values read back from the page.

With these, slice 2's acceptance sentence — nested arrays, unions,
enums, typed evidence — has an installed-provider run for every
dimension (through the Codex path; the CLI path already covered the
flat surface). The remaining slice-2 residue is installed-Victor
specific: its live loop stays blocked on the two facts above.
