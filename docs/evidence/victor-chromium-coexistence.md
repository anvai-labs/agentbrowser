# Victor and native Chromium coexistence acceptance

The remaining gap between the earlier real-stdio/fake-engine Victor test and
the real-browser/in-process MCP test is now covered by one shared scenario.
It runs against the operator panel, the actual Chromium adapter, the built MCP
entrypoint and Victor's real public `MCPClient` implementation. No model provider
or agent narrative acts as the outcome oracle.

## What is checked

1. The operator attaches to a delegated session, prepares a review and grants
   agent control through the actual panel UI.
2. A bound harness discovers the restricted catalog; session creation, closure
   and cookie administration remain absent.
3. The agent observes and clicks a native button. A separate HTTP listener
   records the effect, trusted-event flag and form value.
4. Reusing that operation ID through SDK and MCP is refused without a second
   effect. Overlapping receipt/session queries return their respective results.
5. Operator takeover revokes the old grant. The human-side fixture edits the
   actual browser input after takeover settles, bypassing agent interfaces.
6. Fresh review produces a different token and a new harness process. The old
   harness stays revoked. Its earlier element reference fails under the new grant.
7. A fresh observation includes the human edit. A fresh action records exactly
   one further effect with that value. Both native click events are trusted.

The in-process, Node stdio and Victor variants share all these assertions.
The Python bridge dispatches overlapping requests to Victor rather than
serializing them itself. Victor owns its MCP connection and has automatic
reconnection disabled. The bridge verifies the imported client comes from the
requested checkout. It does not copy or replace Victor's protocol implementation.

## Local reproduction

Builds and focused acceptance use an explicit Victor checkout and its existing
Python environment:

```sh
AGENTBROWSER_VICTOR_ROOT=/absolute/codingagent \
AGENTBROWSER_VICTOR_PYTHON=/absolute/codingagent/.venv/bin/python \
pnpm test:coexistence-victor
```

The command validates these paths before building; missing configuration is an
error, never a successful skipped acceptance. The imported checkout must include
the [companion correlation fix](../delegated-sessions.md#dependency-and-product-decisions)
or an equivalent supported transport correction.

Ordinary workspace tests always run the native Node stdio and in-process paths.
They mark Victor skipped when `AGENTBROWSER_VICTOR_ROOT` is absent, so this
repository does not acquire an implicit cross-repository CI dependency. Setting
the root enables Victor; invalid Python, imports or MCP startup fail the test.
The existing Test job picks up the native stdio regression without another job,
Python install, provider call or remote checkout. The broader local coexistence
command also discovers the three variants.

## Evidence and limits

The scenario first failed because the new transport helper was absent. After
implementation, all three variants passed locally in roughly six seconds.
Victor's overlapping-call variant also passed after removing serialization from
the bridge. Evidence uses AgentBrowser's isolated `feat/delegated-coexistence`
worktree and Victor companion commit `af0d6770d`; Python dependencies come from
the existing codingagent environment. Node is 24.11.1 on macOS arm64.

The independent effects were exactly `[{trusted:true,value:""},
{trusted:true,value:"human edit"}]` for each transport. Harness processes,
browser sessions and fixture listeners are owned by the test and closed during
cleanup. Credentials exist only in fixture memory and subprocess environments;
no persistent MCP registration or production credential was changed.

The fixture automates the human side through native browser input; it does not
claim a live person or model-driven task evaluation. It validates Victor's MCP
client integration, not its planning loop. Live Codex/Claude acceptance, durable
operation recovery, published artifact acceptance and Firefox guarded-service
promotion remain separate gates. No GitHub workflow was dispatched.

The [integration follow-up](coexistence-integration.md) also runs typed fill
mismatch and value-free success evidence through all three transports.
