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
  path and Codex listing path.** Victor live-loop fidelity remains gated on
  F1/F2 (the source-level fidelity repair in Victor #1168 is unaffected).
- Slice 1 (correlation/cancellation/retirement): qualified at the
  CLI/service level (steps 5–6 above); installed-Victor-level correlation
  remains gated on F1/F2.
- Footprint gates (install sizes, RSS): not started.
- T1 cursor: delivery qualified through the installed CLI (step 7);
  consumption/retirement semantics remain with the harness sessions.
