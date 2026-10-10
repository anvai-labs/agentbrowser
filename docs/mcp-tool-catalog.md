# Generated MCP tool catalog

Generated from the built adapter's `tools/list` for every fixed profile and binding.
Do not edit by hand. Build the MCP package, then run `node scripts/mcp-catalog-docs.mjs --write`.
`node scripts/mcp-catalog-docs.mjs` checks drift; the existing release-artifact gate runs it.

This catalog describes protocol 2025-06-18. Protocol 2024-11-05 retains text results
without output schemas or annotations. Autofill and plan advertise validated
structured output contracts. An absent annotation is not a promise of read-only behavior.
Descriptions and annotations are hints, never authorization. Catalog presence does
not prove a live backend, engine capability or current session grant.

Catalog SHA-256 (complete descriptions and schemas): `ca02e75037709f26143d547a92df5e6b551c1c0543b24ebd42b380cfb7a6a36c`

## unbound/qa (17 tools; 49074 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | text JSON | Close a browser session. |
| `cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | text JSON | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/qa (15 tools; 43848 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/operations (17 tools; 49074 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | text JSON | Close a browser session. |
| `cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | text JSON | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/operations (15 tools; 43848 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/audit (16 tools; 44205 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `close` | sessionId | text JSON | Close a browser session. |
| `cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | text JSON | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/audit (14 tools; 38977 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `events_replay` | none | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/appsec (17 tools; 49074 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | text JSON | Close a browser session. |
| `cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | text JSON | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/appsec (15 tools; 43848 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/bounty (17 tools; 49074 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | text JSON | Close a browser session. |
| `cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | text JSON | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/bounty (15 tools; 43848 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/forms (17 tools; 49074 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | sessionId, pageId, action | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `close` | sessionId | text JSON | Close a browser session. |
| `cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `create` | tenantId | text JSON | Create an ephemeral browser session (isolated by default); returns sessionId and an initial pageId. |
| `events_replay` | sessionId | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | sessionId, pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | sessionId | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/forms (15 tools; 43848 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `act` | pageId, action, operationId | urn:agentbrowser:act-outcome:v1 | Act on an element by ref from observe — never CSS/XPath. |
| `autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `events_replay` | none | text JSON | Replay the session's bounded event ledgers oldest-first: console lines and lifecycle events, plus the network summary (request started/finished/failed with policy-denial facts; URLs are query-string-redacted; entries are redacted and page-derived text is untrusted). |
| `extract` | pageId, format | urn:agentbrowser:extract-outcome:v1 | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `observe` | pageId | text JSON | Get a semantic snapshot of the page: roles, names, form state, stable element refs. |
| `operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute ordered action steps in one call (the flat action shape from act; sequential, first hard failure aborts with per-step results). |
| `screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `session` | none | text JSON | Inspect one session's metadata, sampled service-lease deadlines and available pages without refreshing idle lifetime. |
| `snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/application (0 tools; 12 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |

## delegated/application (1 tool; 285 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `operation` | operationId | text JSON | Reconcile a lost response using its operationId. |

Full nested schemas and complete descriptions are available through `tools/list`.
The digest detects changes even when a summary row stays the same. Tool errors retain
text diagnostics; failed valid reports retain their receipts and set `isError: true`.
Do not retry uncertain writes automatically. See the [MCP package guide](../packages/mcp-server/README.md).
