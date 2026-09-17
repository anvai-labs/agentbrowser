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
