# Generated MCP tool catalog

Generated from the built adapter's `tools/list` for every fixed profile and binding.
Do not edit by hand. Build the MCP package, then run `node scripts/mcp-catalog-docs.mjs --write`.
`node scripts/mcp-catalog-docs.mjs` checks drift; the existing release-artifact gate runs it.

This catalog describes protocol 2025-06-18. Protocol 2024-11-05 retains text results
without output schemas or annotations. Autofill and plan advertise validated
structured output contracts. An absent annotation is not a promise of read-only behavior.
Descriptions and annotations are hints, never authorization. Catalog presence does
not prove a live backend, engine capability or current session grant.

Catalog SHA-256 (complete descriptions and schemas): `667b5b07dc25cc3dc321f3b01bcb7c359f668a561ca6b11cc53e351e712ff228`

## unbound/qa (20 tools; 72224 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | urn:agentbrowser:session-closed:v1 | Close a browser session. |
| `cookie_handoff` | sessionId, domains | urn:agentbrowser:cookie-handoff:v1 | Hand the operator's login cookies for exact domains into this session (TD-BROWSER-16, ADR-025 s3). |
| `cookies` | sessionId | urn:agentbrowser:cookie-list:v1 | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | urn:agentbrowser:session-created:v1 | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | sessionId | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## delegated/qa (17 tools; 61556 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | urn:agentbrowser:operation-record:v1 | Reconcile a lost response using its operationId. |
| `page_create` | operationId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | none | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## unbound/operations (20 tools; 72224 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | urn:agentbrowser:session-closed:v1 | Close a browser session. |
| `cookie_handoff` | sessionId, domains | urn:agentbrowser:cookie-handoff:v1 | Hand the operator's login cookies for exact domains into this session (TD-BROWSER-16, ADR-025 s3). |
| `cookies` | sessionId | urn:agentbrowser:cookie-list:v1 | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | urn:agentbrowser:session-created:v1 | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | sessionId | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## delegated/operations (17 tools; 61556 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | urn:agentbrowser:operation-record:v1 | Reconcile a lost response using its operationId. |
| `page_create` | operationId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | none | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## unbound/audit (19 tools; 66275 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `close` | sessionId | urn:agentbrowser:session-closed:v1 | Close a browser session. |
| `cookie_handoff` | sessionId, domains | urn:agentbrowser:cookie-handoff:v1 | Hand the operator's login cookies for exact domains into this session (TD-BROWSER-16, ADR-025 s3). |
| `cookies` | sessionId | urn:agentbrowser:cookie-list:v1 | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | urn:agentbrowser:session-created:v1 | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | sessionId | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## delegated/audit (16 tools; 55605 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `events_replay` | none | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | urn:agentbrowser:operation-record:v1 | Reconcile a lost response using its operationId. |
| `page_create` | operationId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | none | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## unbound/appsec (20 tools; 72224 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | urn:agentbrowser:session-closed:v1 | Close a browser session. |
| `cookie_handoff` | sessionId, domains | urn:agentbrowser:cookie-handoff:v1 | Hand the operator's login cookies for exact domains into this session (TD-BROWSER-16, ADR-025 s3). |
| `cookies` | sessionId | urn:agentbrowser:cookie-list:v1 | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | urn:agentbrowser:session-created:v1 | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | sessionId | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## delegated/appsec (17 tools; 61556 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | urn:agentbrowser:operation-record:v1 | Reconcile a lost response using its operationId. |
| `page_create` | operationId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | none | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## unbound/bounty (20 tools; 72224 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | urn:agentbrowser:session-closed:v1 | Close a browser session. |
| `cookie_handoff` | sessionId, domains | urn:agentbrowser:cookie-handoff:v1 | Hand the operator's login cookies for exact domains into this session (TD-BROWSER-16, ADR-025 s3). |
| `cookies` | sessionId | urn:agentbrowser:cookie-list:v1 | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | urn:agentbrowser:session-created:v1 | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | sessionId | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## delegated/bounty (17 tools; 61556 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | urn:agentbrowser:operation-record:v1 | Reconcile a lost response using its operationId. |
| `page_create` | operationId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | none | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## unbound/forms (20 tools; 72224 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | urn:agentbrowser:session-closed:v1 | Close a browser session. |
| `cookie_handoff` | sessionId, domains | urn:agentbrowser:cookie-handoff:v1 | Hand the operator's login cookies for exact domains into this session (TD-BROWSER-16, ADR-025 s3). |
| `cookies` | sessionId | urn:agentbrowser:cookie-list:v1 | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | urn:agentbrowser:session-created:v1 | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | sessionId | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## delegated/forms (17 tools; 61556 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | urn:agentbrowser:session-events-page:v1 | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | urn:agentbrowser:page-html:v1 | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | urn:agentbrowser:operation-record:v1 | Reconcile a lost response using its operationId. |
| `page_create` | operationId | urn:agentbrowser:page:v1 | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | urn:agentbrowser:page-list:v1 | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results; at most 100 steps per plan). |
| `policy` | none | urn:agentbrowser:policy-answer:v1 | Read-only policy surface (TD-BROWSER-15): with no arguments, the loaded policy summary (version, limits, capabilities for a default session of the caller tenant); with an action and optional target, what the policy would decide — answers never resolve DNS. |
| `scope` | none | urn:agentbrowser:scope-tool:v1 | Read a scoped session's engagement scope: the rules in effect, request budget used and remaining, expiry and denials by sub-code (identity bindings show header and hosts, never the value). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | urn:agentbrowser:session-inspection:v1 | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | urn:agentbrowser:page-snapshot:v1 | Read a self-contained page snapshot with current refs. |

## unbound/application (0 tools; 12 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |

## delegated/application (1 tool; 838 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `operation` | operationId | urn:agentbrowser:operation-record:v1 | Reconcile a lost response using its operationId. |

Full nested schemas and complete descriptions are available through `tools/list`.
The digest detects changes even when a summary row stays the same. Tool errors retain
text diagnostics; failed valid reports retain their receipts and set `isError: true`.
Do not retry uncertain writes automatically. See the [MCP package guide](../packages/mcp-server/README.md).
