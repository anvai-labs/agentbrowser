# T1 context/profile qualification evidence

Status: active implementation evidence for T1. This record distinguishes catalog
serialization, tokenizer counts and process memory; none is used as a substitute for
the others.

## Profile and cursor boundary

The protocol registry is the only mode/capability source. A delegated grant pins one
mode and the service independently enforces its capabilities. MCP projects that same
registry into a catalog fixed for the connection lifetime.

Each grant now returns a versioned, non-secret run cursor containing the service
generation, fresh binding generation, session ID, control epoch, mode and profile
revision. The authority retains only the current binding. Takeover/re-delegation,
session changes and service restart
therefore change at least one cursor scope component. An operator-mediated application
account change is scoped only when it follows that takeover and fresh delegation; an
account change inside a live grant must be grounded by page/document revision and does
not change the cursor. The cursor contains no tenant, bearer token, private value,
page content or evidence payload and grants no
authority. Harnesses may use the complete cursor as a memory/cache namespace; they
must not merge scopes by similarity. Mutable recovery state stays in the existing
`ControlView.operation` and operation-status lookup, so an in-flight write cannot make
the stable cursor split and later revert to a stale pre-write cache key.

Focused tests cover renewed bindings, mode switches, same-service cross-tenant sessions,
service replacement, stable cursor identity while operation status changes,
token/tenant absence, and transport schema delivery. The operator panel projects the
canonical registry into an inline native select and capability summary. It supports
normal Tab/Enter interaction
and does not require arrow-left navigation or a hidden panel. It tells operators to
start a fresh harness context when previously loaded data must be isolated.

## Footprint measurement

Command, from a built checkout on 2026-09-16 UTC:

```sh
node scripts/mode-footprint.mjs --samples 3 \
  --tokenizer-python ../codingagent/.venv/bin/python
```

Environment: macOS arm64 25.2.0, Node v24.11.1, three fresh processes per row.
`baselineRssBytes` is a fresh Node process before imports; cold RSS is after importing
the built MCP adapter; warm RSS is after construction, initialization and ten identical
`tools/list` requests. Reported absolute values and paired per-process deltas are
medians. The probe does not launch a
browser, scanner or service and is deliberately a manual measurement rather than a
flaky CI threshold.

Exact compact `tools/list` result sizes and tokenizer counts group identical catalogs:

| Profile shape | Binding | Tools | Bytes | cl100k_base tokens | o200k_base tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| qa/operations/appsec/bounty/forms | unbound | 13 | 24,964 | 5,597 | 5,808 |
| qa/operations/appsec/bounty/forms | delegated | 12 | 22,355 | 5,021 | 5,205 |
| audit | unbound | 12 | 20,444 | 4,556 | 4,708 |
| audit | delegated | 11 | 17,833 | 3,979 | 4,105 |
| application | unbound | 0 | 12 | 4 | 4 |
| application | delegated | 1 | 293 | 57 | 57 |

These are exact encoding counts for the serialized catalog string under the named
tokenizers. Provider message framing and a different model tokenizer can change the
actual prompt charge; the probe never labels byte/4 estimates as tokens.

Across all 14 rows, median cold import RSS delta ranged from 9,814,016 to 10,207,232
bytes. Warm catalog projection added 1,064,960 to 1,114,112 bytes for full/audit
profiles, 180,224 bytes for unbound application, and 196,608 bytes for delegated
application. Absolute warm RSS ranged from 52,133,888 to 53,280,768 bytes. The common
module import dominates RSS, so the result supports a context-token benefit for the
smaller catalogs but no general process-memory saving claim. Installed dependency size
is unchanged because the implementation adds no dependency.

## Remaining qualification boundary

Codex, Claude and Victor still need T8 end-to-end checks that their installed clients
consume the fixed catalog and preserve the complete cursor as a scope key. A profile
change requires a fresh connection. Hiding a tool cannot erase data already loaded in
an existing model transcript, and the cursor does not make ephemeral operation records
durable across service restart.

## 2026-10-01 update: installed-MCP-harness cursor consumption/retirement qualified

The T8 boundary ("installed Codex/Claude/Victor cursor consumption") was
exercised through the installed `agentbrowser-mcp` 1.14.0 binary acting as
the bound harness, against a keyed scratch server on :5810 (operator side
via the installed CLI). Lifecycle, all pass: delegate → all seven cursor
fields delivered; bound harness observes control state AGENT_ACTIVE;
operator takeover revokes the grant (harness call refused); prepare-resume
under human authority advances the control epoch; re-delegate with the
fresh epoch issues a new grant; the harness reconnects with the fresh
grant and reports AGENT_ACTIVE; an old-epoch re-delegate is refused.
Driver: scripted JSON-RPC over stdio (ephemeral /tmp/t1-cursor-
consumption.mjs; the checks above are the record). Remaining T8 work:
the same consumption/retirement semantics through the providers' own
tool-call paths (the Codex path now executes tool calls — the approval
gate was resolved 2026-10-02, see the T8 availability record — and
[Erratum 2026-10-03: cursor semantics ARE now exercised through it —
see the 2026-10-03 section below]; the Victor live loop remains
blocked on the Sandhi TLS trust decision, with the formula skew
repaired locally).

## 2026-10-03 update: cursor consumption/retirement through the Codex provider path

The remaining T1 work item above is now qualified on its provider half:
the full delegate → takeover → resume → re-delegate choreography ran
through the Codex provider's own tool-call path (codex-cli 0.157.1
driving the installed `agentbrowser-mcp` 1.15.0 binary, bound via
AGENTBROWSER_SESSION_ID and authenticated with the delegated bearer as
the harness credential, against a keyed scratch :5812 service):

1. **Delegate**: the operator reviewed and delegated (epoch 2); the
   bound harness read AGENT_ACTIVE with ALL SEVEN cursor fields
   (version, serviceGeneration, bindingGeneration, sessionId,
   controlEpoch, mode, profileRevision) delivered intact through the
   provider round trip.
2. **Takeover**: the operator took over (epoch 3, HUMAN_ACTIVE); the
   harness's next call with the REVOKED bearer was refused —
   `UNAUTHORIZED: A valid bearer credential is required`.
3. **Resume + re-delegate**: prepare-resume (epoch 4) then re-delegate
   issued a fresh bearer and a NEW bindingGeneration; the harness read
   AGENT_ACTIVE with the fresh cursor (controlEpoch 5).
4. **Old-epoch refusal**: a stale-epoch re-delegate (epoch 4 against a
   current epoch of 5) was refused `CONTROL_REVOKED: A current human
   review is required`, and the active grant was unharmed.

Remaining T1 residue narrows to: the same choreography on the Victor
live loop (blocked on the Sandhi TLS trust decision, an operator call)
and the Claude provider path (additional, unrequired coverage).

## 2026-10-04 update: cursor consumption/retirement through the Claude provider path

The same choreography ran through Claude Code's tool-call path
(claude-code 2.1.285 driving the installed `agentbrowser-mcp` 1.15.1
binary via `--mcp-config`, bound via AGENTBROWSER_SESSION_ID and
authenticated with the delegated bearer as the harness credential, on
a keyed scratch :5812 service):

1. **Delegate** (epoch 2): the bound harness read AGENT_ACTIVE with
   ALL SEVEN cursor fields delivered intact.
2. **Takeover** (epoch 3): the harness's next call with the REVOKED
   bearer was refused — `UNAUTHORIZED: A valid bearer credential is
   required`.
3. **Resume + re-delegate** (epoch 4 → 5): a fresh bearer and a NEW
   bindingGeneration; the harness read AGENT_ACTIVE with the fresh
   cursor at epoch 5.
4. **Old-epoch refusal**: a stale-epoch re-delegate was refused
   `CONTROL_REVOKED: A current human review is required`, and the
   active grant was unharmed.

With both the Codex and Claude provider paths qualified, the
installed-harness cursor consumption/retirement coverage is complete
for every available provider. The only remaining residue is Victor's
live loop (blocked on the Sandhi TLS trust decision, an operator
call).

## Same tenant, different principal (2026-10-15)

The acceptance row reads: "Test same tenant/different principal and operator-mediated
account/mode switches for stale-memory leakage." Its two halves are covered in
`packages/control/src/session-authority.test.ts` as follows.

**Same tenant, different principal** (new):

- **Agents.** Two delegated sessions of one tenant get distinct run cursors (memory is
  cursor-scoped): different `sessionId` and `bindingGeneration`. Each agent principal is
  refused (`CONTROL_REQUIRED`) on the other session; the session identity and the
  per-grant binding generation both differ there, and the `sessionId` comparison alone is
  pinned by the existing altered-principal test. A human takeover revokes the session's
  agent principal at once; re-delegation mints a new principal and binding generation, the
  earlier token never authenticates again and its principal is refused, while the other
  session's grant is untouched. A session whose grant is still live cannot even be
  re-reviewed: the review precondition refuses before delegation.
- **Operators.** Admission keys on the tenant alone (`admit()`): two operator
  principals of one tenant are one principal by design, and another tenant's operator
  is refused. This is pinned as intended behaviour, not a gap. (The cross-tenant refusal is
  the only test that catches an operator check ignoring the tenant.)

**Operator-mediated account/mode switches** (existing): a mode change on re-delegation
mints a new cursor and binding generation ("issues non-secret run cursors that isolate
service, binding and mode memory") and retires the old token ("binds a trusted mode to the
bearer grant…"). An account switch inside a
live grant is page/document-revision state by the packet's own rule; across grants it is
the takeover-then-re-delegate choreography above.

## 2026-10-15 update: footprint re-measured after the output schemas (M2)

`node scripts/mode-footprint.mjs --samples 3 --tokenizer-python python3`, run on Linux x64 (WSL2)
with Node v24.21.0 from a built develop checkout:

| Profile shape | Binding | Tools | Bytes | cl100k_base tokens | o200k_base tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| qa/operations/appsec/bounty/forms | unbound | 19 | 67,945 | 15,704 | 16,566 |
| qa/operations/appsec/bounty/forms | delegated | 16 | 57,368 | 13,348 | 14,115 |
| audit | unbound | 18 | 62,868 | 14,540 | 15,333 |
| audit | delegated | 15 | 52,289 | 12,183 | 12,882 |
| application | unbound | 0 | 12 | 4 | 4 |
| application | delegated | 1 | 838 | 193 | 203 |

The full catalog grew about 2.7× since the 2026-09-16 row (24,964 bytes, 13 tools). Two causes:
- **Six more tools.**
- **Output schemas**, now on all 19 tools (T0 M2). They are 29,179 of the 67,945 bytes (43%);
  input schemas are 27,488.
- Output schemas are advertised only when a client negotiates the structured protocol. A
  `2024-11-05` client receives a 38,342-byte catalog with the same 19 tools and no output schemas.

The profile reduction still holds: the application profile is 4–203 tokens against about 16k for
the full catalog.

**RSS:** median cold import delta 13.9–14.6 MB; warm catalog projection 2.1–2.7 MB for full/audit
profiles and 0.66 MB for application; absolute warm RSS 58.5–60.9 MB. The common import still
dominates, so the earlier conclusion stands: a context-token benefit, no general memory-saving
claim. These are not comparable byte-for-byte with the macOS arm64 rows above (different
platform and Node).
