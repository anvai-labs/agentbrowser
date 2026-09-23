# C2d: public inspection and decision for qualified evidence reviews

Base: develop `9a87b49` (#247). Load forms/T6 and application/T4 only. Reuse the
existing approval GET/POST, SDK sessions methods and CLI `session approval` /
`session approval-decide` for host-created evidence records. No new route, command,
schema catalog, registry, token store or executor. Creation and consumption remain
internal; a public decision does not dispatch a browser/application action.

## Trusted source selection

Add an optional synchronous deployment-owned `evidenceReviewProvider` to service
and embedding server configuration. Capture it once at construction. It receives a
bounded immutable request containing authoritative tenant/session/incarnation/page
identity plus the stored source owner ID and contract ID/version. Do not pass the
stored witness, private intended action or caller-provided selectors to the resolver.
This metadata selects configuration; it is not proof of present permission.

The resolver independently returns current `{action,source}` composition or refuses.
The source retains the existing permission-owner incarnation, monotonic permission
generation, synchronous assertions and qualified collector contract. No provider,
unknown source, malformed/accessor-backed return or asynchronous result fails closed.
Errors contain no callback text or private values. No environment variable evaluates
source code, and no request can install a resolver or arbitrary collector.

## Ownership and disclosure

Authorize operator scope through the existing route and SessionAuthority. Obtain the
gate record under the existing review context; a foreign token never reaches source
selection. Before invoking the resolver, capture the exact native page/admission
fence and review context. Recheck those same owners after callback, result inspection,
preparation and on failure. Replacing a page/session during resolution cannot become
the newly accepted owner. Capture a fresh source for each admission, never callbacks
inside persisted token data.

Use the existing prepared review's `get` or `decide`, including current source
permission, exact action/source-owner/generation matching and disclosure checks.
Do not route reserved decisions through the ordinary raw gate tail after one earlier
read. Gate mutation and private output need the full source checks. Ordinary action
approvals retain their existing path. Missing/revoked evidence sources never fall
back to action-only approval, even when the operator still possesses the token.

The operator reviews the stored immutable snapshot. Approval records the authority
of operator credentials; it does not prove a person was present or that live content
has stayed unchanged. Internal consumption recollects and compares; qualified atomic
dispatch/acceptance remains C3. Preserve operation-ID reconciliation: a replay exposes
status, not stored private evidence. Inspecting evidence again must reauthorize.

## CLI, transport and acceptance

Reuse existing schemas/parsers and `describe`. Clarify that configured qualified
evidence may appear in private JSON output; text output remains bounded status only.
Do not advertise default live-portal or MCP evidence-review capability. A production
source resolver and qualified collector must be supplied by trusted embedding code.

TDD covers absent/missing/malformed/async resolver, immutable routing metadata,
callback capture, session/page replacement, wrong source owner/generation, revocation,
secret disclosure, failed decision and unchanged ordinary approvals. Use the existing
synthetic Chromium draft fixture with its app-owned oracle; extend rather than copy
it. Drive real REST/SDK and compiled CLI inspection/decision, wrong tenant/delegated
refusal, status-only replay after revocation, and fresh internal consumption failure
after app/UI drift. Every public review path has zero submission/engine dispatch.

Run focused tests and mandatory hooks, exact-head independent review, one ready PR
and green PR/post-merge CI. Keep published 1.9.1 and live sessions unchanged. Public
creation, application-specific atomic dispatch and live source/harness qualification
remain explicit follow-ups; this slice alone does not complete T4/T6.
