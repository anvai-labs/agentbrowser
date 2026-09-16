# Security and trust-boundary design

Status: target requirements with known current limitations. This specification does
not certify hosted containment or implement a penetration-testing engine.

## Trust boundaries

| Boundary | Threat | Required control |
| --- | --- | --- |
| Harness to service | Forged actor/scope, replay, oversized input | Host authentication, bounded schema validation, scoped admission |
| Human and agent control | Revoked writer dispatches or receives buffered data | Epoch fencing, drain semantics and authorization at delivery |
| Page to agent | Prompt injection, forged tools or success text | Untrusted data framing; registry/policy never inferred from page content |
| Browser to network | SSRF, redirect/DNS/worker bypass | Qualified deployment-specific network boundary; explicit capability refusal |
| Application adapter | Confused deputy, arbitrary endpoint/code registration | Trusted registered adapter and resource/account binding |
| Artifact store | Cross-tenant access, secret leakage, malicious HTML | Authorization per read, scoped IDs, retention, safe download/viewing |
| Optional scanner | Out-of-scope active traffic, dangerous replay | Explicit test scope and independently enforced request budget |
| Build/release | Unreviewed code or compromised dependency publishes | Protected PR path, pinned provenance and tag ancestry qualification |

## Local and hosted profiles

Local functional automation is qualified independently from hostile multi-tenant
containment. Current engine routing has known redirect, DNS and target coverage
limitations; real Safari guarded service creation is unsupported. Respect the
[engine matrix](../engines.md) and deferred [transport contract](../transport-integration-contract.md).
Never claim that a mode name or HTTP proxy closes these holes.

Hosted hostile workloads require independently enforced process/filesystem/network
isolation, tenant quotas, credential partitioning and complete egress qualification.
Reject unsupported deployment claims rather than silently downgrade policy. This
design records the gate without authorizing the deferred gateway implementation.

## Authority and sensitive operations

Mode profiles can narrow granted operations, not grant new ones. Bind consequential
actions to relevant target and business preconditions. Reuse existing approval and
risk helpers; do not introduce a different consent engine in every mode. Existing
authorization persists within its actual scope; prompt only for new authority or
material missing information. Tool annotations and UI badges are not enforcement.

Test scope for appsec/bounty includes hosts, ports, schemes, paths, methods, accounts,
time window, rate/concurrency/byte limits, permitted test classes and data handling.
Resolve redirects and scanner traffic against this scope. An approved initial URL
does not authorize every subsequent request. The application's own authorization
remains independently required. Active testing is a separately granted capability.

## Privacy and evidence

Raw HTML, screenshots, downloads and network captures can contain personal data,
credentials and attacker-controlled content. Default reports contain redacted bounded
summaries and opaque evidence references. Comparison uses private full values before
redaction; redacted equality is not a verifier. Protect low-entropy retained values
with scoped keyed fingerprints where needed; hashes are not anonymization.

Artifact fetches recheck principal, tenant, session/resource scope and retention.
Render untrusted HTML as escaped text or download from an isolated origin, never as
trusted application UI. MIME type, size and decompression limits apply. Reuse shared
artifact storage; add capture formats through adapters, not separate stores per mode.
Remote upload of reports requires destination authorization and explicit data policy.

## Local service and transport

Bind default local listeners to loopback, validate Host/Origin, and authenticate
nontrivial session authority. Remote use requires TLS and scoped credentials.
Cookie-authenticated UI writes require CSRF defenses. Do not put tokens in event URLs,
logs, process arguments or durable continuation files. Endpoint discovery does not
establish service identity. A bridge must not kill a shared service it did not launch.

Cancellation/reconnect never replays uncertain writes. Authorize status lookup even
when an operation ID is known. Do not reveal another principal's stored results when
returning a deduplication conflict. Bound pending transport calls and ignore unmatched
late responses after recording their diagnostic metadata without sensitive content.

## Application-security coverage

Map supported tests to versioned objectives in the
[OWASP Web Security Testing Guide](https://owasp.org/projects/web-security-testing-guide).
Coverage claims name the tested category and fixture. A successful authenticated
browser flow is not an assessment of SQL injection, authorization, cryptography or
the entire application. Integrate established diagnostic/scanner engines behind
typed ports; do not implement another payload database as part of this foundation.

Required negative tests include cross-tenant artifact IDs, forged scopes, revoked
grants, stale operation replay, nested schema abuse, malicious page instructions,
out-of-scope redirects, unsafe HTML viewing, secret-bearing error messages and scanner
budget exhaustion. Any inability to enforce the promised test scope blocks that
capability, while other independently qualified local functionality remains explicit.
