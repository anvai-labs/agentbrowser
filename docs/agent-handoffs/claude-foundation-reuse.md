# Claude handoff: reuse AgentBrowser foundations

Purpose: cross-validate existing capabilities before adding an integration. Build on
T0–T3 through the existing binaries and common service; do not create another CLI,
browser controller, session authority, schema registry or execution framework.
This is an on-demand handoff, not part of the default model context.

## Latest takeover

The foundation-alignment sequence is merged through PR #222. Use the
[verified handback checkpoint](../spec/evidence/foundation-handback-recheck.md) before
repeating any assignments below. Installed CLI/service now report 1.9.0; earlier
1.8.20 installation observations in this original handoff are historical. Navigation
reset is delivered. The develop candidate now implements [offline CLI evaluation](../spec/evidence/t3-cli-evaluation.md):
reuse `test evaluate` after discovering its schema, without copying case verdict logic.
Published 1.9.0 lacks this command. The [native JUnit slice](../spec/design/t3-node-test-qualification.md)
adds internal failure-report probes; external conventional-runner qualification remains
separate. Do not mistake deliberately red probe XML for an ordinary passing CI suite.

## Verified baseline and limits

Release **v1.9.0** is published from main `02f263f`; develop includes it through
`4dbd489` (PR #211). The first T3 bound-report slice merged to develop at
`4dd96e9` (PR #212), with all eight PR and merge CI checks green.
A package version alone does not identify this post-release candidate.

| Foundation | Already available | Still needs qualification or implementation |
| --- | --- | --- |
| T0 | Released CLI offline `describe`, canonical bulk schemas, bounded JSON reader, SDK/service execution and MCP bulk result validation | Discover the actual installed command and schema; offline metadata does not prove live capability or permission. |
| T1 | Local selective spec loader, shared mode registry, service-enforced grants, fixed MCP profiles and non-secret run cursor | Loader is checkout tooling, not a new installed CLI command. Installed Claude/Codex/Victor cursor consumption and context retirement remain T8; T1 overall remains active. |
| T2 | Released CLI/SDK/REST `outcome`, bound verification, application permissions and receipt correlation | Configure a trusted verifier, source and explicit policy for each application. No production receipt source is registered by default; G4 fixture evidence is not G6 independence or durable recovery. |
| T3 | Develop `createTestCaseRunContract`, offline CLI `test evaluate` and 13-case packaged acceptance through `outcome`/evaluation | Candidate evaluator is absent from published 1.9.0. No `agentbrowser test run`, public runner, JUnit/HTML exporter or MCP outcome tool. T3 remains active. |

Local cross-check during this handoff:

- Downloaded published Darwin arm64 CLI reports **1.9.0**; `describe` includes
  `outcome`, and `describe outcome --schema` includes canonical input/output schemas.
- Homebrew's three links (`agentbrowser`, `agentbrowser-server`, `agentbrowser-mcp`)
  still resolve to **1.8.20**; installed CLI confirms that version. Publishing and tap
  promotion did not upgrade this machine. Do not infer server/MCP runtime versions
  solely from their link paths, or upgrade/restart a user's service implicitly.
- The old published protocol fails the new T3 factory acceptance probe, as expected.
  The first slice's dirty extracted package passed all eight acceptance groups on
  Node 22, with `releaseEvidence: false`. PR #212 supplies separate merge/CI proof;
  this package artifact remains local evidence, not release proof.
- A running service and installed Claude integration were not qualified here.
  Server/MCP launchers are not safe generic `--version` probes: inspect package/build
  metadata, CLI discovery and the documented service health interface instead.

## Copyable assignment

> Continue AgentBrowser integration using the existing T0/T1/T2 foundations and the
> first T3 slice where actually available. First verify checkout, installed CLI,
> package/build identity, service and delegated capabilities separately. Use a clean
> isolated worktree and inspect current remote develop; preserve unrelated work.
> Treat this handoff's versions as observations to recheck, not moving requirements.
>
> Prefer shell + existing `agentbrowser` CLI + existing service. MCP is optional.
> Reuse the SDK/REST client when programmatic access is necessary. Keep policy,
> sessions, operation identity, execution and verification in their current owners.
> Return a capability matrix with evidence before proposing any missing surface.
>
> Load only the selected task context and requested command schema. Reuse the common
> helpers listed below, add a failing regression for each real gap, implement the
> smallest compatible change, and run affected tests locally before one CI cycle.
> Request adversarial review of the exact committed head; use ordinary PR/merge rules
> and all required checks. Record each repository's delivery separately. Do not call
> T3 or installed harness qualification complete based on the fixture alone.

## First cross-validation steps

From the selected AgentBrowser checkout:

```sh
git status --short
git log -1 --format='%H %s'
command -v agentbrowser
agentbrowser --version
agentbrowser describe | jq '{productVersion, scope, commands: .command.commands}'
agentbrowser describe outcome --schema >outcome-schema.json
node scripts/spec-context.mjs --mode qa --task t3 --format json >task-context.json
```

`describe` works offline. Inspect only the next necessary path, for example
`describe session control`, `describe session operation` or `describe health`.
Check the configured service through its documented read-only health command and
record product/build identity and engine metadata separately. Obtain an authorized
session/grant from the existing operator flow; do not infer permission from help.
Keep credentials out of prompts, command arguments, logs and reports.

Select only one mode/task context. The loader reports selected modules, hashes and
serialized bytes; those are not model-token or RSS measurements. The design and
qualification evidence linked by T3 are optional reads, not recursive imports.

## Common owners to preserve

| Concern | Reuse owner / seam |
| --- | --- |
| CLI discovery, JSON input and invocation | Existing command definitions and input reader in `packages/cli/src`; existing SDK calls. No second catalog/parser. |
| Contracts and truth | `packages/protocol/src`: execution/outcome parsers, `isPassingOutcome`, operation IDs; candidate `test-run.ts` owns bound case parsing and truth. |
| Permissions and continuation | Existing control/session authority and canonical mode registry. Cursor includes service/binding generation, session, epoch, mode and profile revision; it is not a credential. |
| Application evidence | Existing application ports, trusted registration, permission policy and scoped receipt contract. Generic matching state/receipts cannot establish a UI event. |
| Deterministic regression lifecycle | `scripts/cli-outcome-acceptance.mjs`, its child fixture, `scripts/package-acceptance.mjs` and existing testkit. Extend these before extracting another framework. |
| Delivery and selection | Existing package acceptance, release-artifact gate and `scripts/spec-context.mjs`. No new workflow/job/dependency just to duplicate coverage. |

Keep all cursor fields in the memory scope; invalidate selected memory on any scope
change. A page/account change within a grant also needs current document evidence.
Keep pending operation IDs separate from the stable cursor. A lost write response
requires `session operation` and qualified application evidence, never blind retry;
restart does not provide durable outcome recovery today.

Keep service invocation IDs distinct from application business receipt IDs. Use the
existing bounded JSON file/stdin reader for `outcome`; retain stdout on nonzero exit.
Do not turn HTTP success, UI appearance, a model statement, optional-only assertions
or skipped required assertions into a passing verdict.

## Bounded follow-up tasks

1. **Compatibility inventory:** record installed paths/versions, service identity,
   source commit, grants and actual CLI schema. Identify whether the T3 export is
   present. Keep published, installed and candidate evidence separate.
2. **Reuse audit:** trace each existing binary to its shared owner and list only
   concrete missing projections. The server composes policy/execution; CLI calls the
   SDK/service; MCP remains an optional projection. Do not copy T3 into each binary.
3. **Thin T3 integration:** if a public regression surface is needed, review the T3
   design first. Reuse the bound contract and existing outcome execution; prove
   navigation reset, cleanup/finalizer failure and version drift. An exporter must
   consume the bound qualified result, retain failure evidence and never reconstruct
   truth from an unbound report. Do not implement a new workflow DSL or scheduler.
4. **Installed Claude qualification (T8):** test actual shell invocation, schema
   fidelity, exit/report preservation, uncertain writes, cursor retirement and
   cleanup. Registration or a successful tool listing alone is not qualification.
   Coordinate `../codingagent`/Victor through its existing harness interface with
   separate tests, commits, PRs and release evidence; do not assume any such change
   was shipped by the AgentBrowser release.
5. **Delivery record:** report tests, exact reviewed head, PR, required CI and merge
   status. Keep T3 completion and its dependent T7/T8 gates closed until their full
   acceptance criteria are met. Existing T0-only T8 work can proceed independently.

Read [CLI usage](../cli-agent-usage.md), the [task index](../spec/tasks/README.md),
[T3 design](../spec/design/t3-regression-report.md) and
[T8 qualification](../spec/tasks/t8-harness-qualification.md) only as needed.
