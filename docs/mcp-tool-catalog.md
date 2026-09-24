# Generated MCP tool catalog

Generated from the built adapter's `tools/list` for every fixed profile and binding.
Do not edit by hand. Build the MCP package, then run `node scripts/mcp-catalog-docs.mjs --write`.
`node scripts/mcp-catalog-docs.mjs` checks drift; the existing release-artifact gate runs it.

This catalog describes protocol 2025-06-18. Protocol 2024-11-05 retains text results
without output schemas or annotations. Autofill and plan advertise validated
structured output contracts. An absent annotation is not a promise of read-only behavior.
Descriptions and annotations are hints, never authorization. Catalog presence does
not prove a live backend, engine capability or current session grant.

Catalog SHA-256 (complete descriptions and schemas): `c96da4706cf0aed8dd9eea6f6e1d39f87ce14408381896972712b5e03379c800`

## unbound/qa (15 tools; 39834 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | sessionId, pageId, action | text JSON | Act through current element refs. |
| `browser_autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_close` | sessionId | text JSON | Close a browser session. |
| `browser_cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `browser_create` | tenantId | text JSON | Create a new isolated browser session. |
| `browser_extract` | sessionId, pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/qa (14 tools; 37216 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | pageId, action, operationId | text JSON | Act through current element refs. |
| `browser_autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_extract` | pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `browser_page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_session` | none | text JSON | Inspect the delegated session control status and available pages. |
| `browser_snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/operations (15 tools; 39834 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | sessionId, pageId, action | text JSON | Act through current element refs. |
| `browser_autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_close` | sessionId | text JSON | Close a browser session. |
| `browser_cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `browser_create` | tenantId | text JSON | Create a new isolated browser session. |
| `browser_extract` | sessionId, pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/operations (14 tools; 37216 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | pageId, action, operationId | text JSON | Act through current element refs. |
| `browser_autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_extract` | pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `browser_page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_session` | none | text JSON | Inspect the delegated session control status and available pages. |
| `browser_snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/audit (14 tools; 34983 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | sessionId, pageId, action | text JSON | Act through current element refs. |
| `browser_close` | sessionId | text JSON | Close a browser session. |
| `browser_cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `browser_create` | tenantId | text JSON | Create a new isolated browser session. |
| `browser_extract` | sessionId, pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/audit (13 tools; 32363 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | pageId, action, operationId | text JSON | Act through current element refs. |
| `browser_extract` | pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `browser_page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_session` | none | text JSON | Inspect the delegated session control status and available pages. |
| `browser_snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/appsec (15 tools; 39834 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | sessionId, pageId, action | text JSON | Act through current element refs. |
| `browser_autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_close` | sessionId | text JSON | Close a browser session. |
| `browser_cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `browser_create` | tenantId | text JSON | Create a new isolated browser session. |
| `browser_extract` | sessionId, pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/appsec (14 tools; 37216 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | pageId, action, operationId | text JSON | Act through current element refs. |
| `browser_autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_extract` | pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `browser_page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_session` | none | text JSON | Inspect the delegated session control status and available pages. |
| `browser_snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/bounty (15 tools; 39834 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | sessionId, pageId, action | text JSON | Act through current element refs. |
| `browser_autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_close` | sessionId | text JSON | Close a browser session. |
| `browser_cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `browser_create` | tenantId | text JSON | Create a new isolated browser session. |
| `browser_extract` | sessionId, pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/bounty (14 tools; 37216 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | pageId, action, operationId | text JSON | Act through current element refs. |
| `browser_autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_extract` | pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `browser_page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_session` | none | text JSON | Inspect the delegated session control status and available pages. |
| `browser_snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/forms (15 tools; 39834 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | sessionId, pageId, action | text JSON | Act through current element refs. |
| `browser_autofill` | sessionId, pageId, fields | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_close` | sessionId | text JSON | Close a browser session. |
| `browser_cookies` | sessionId | text JSON | Export the session context cookies (TD-BROWSER-6). |
| `browser_create` | tenantId | text JSON | Create a new isolated browser session. |
| `browser_extract` | sessionId, pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | sessionId, pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | sessionId, pageId, url | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | sessionId, pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_page_create` | sessionId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | sessionId | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | sessionId, pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | sessionId, pageId, actions | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | sessionId, pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_snapshot` | sessionId, pageId | text JSON | Read a self-contained page snapshot with current refs. |

## delegated/forms (14 tools; 37216 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_act` | pageId, action, operationId | text JSON | Act through current element refs. |
| `browser_autofill` | pageId, fields, operationId | urn:agentbrowser:autofill-report:v1 | Fill and verify structured fields in one serial server operation. |
| `browser_extract` | pageId, format | text JSON | Extract deterministic structured data from the page: visible text, article markdown, links (text/URL/rel), tables (headers + rows), observed form controls with refs, or JSON-LD. |
| `browser_html` | pageId | text JSON | Fetch the page's current HTML as inline text. |
| `browser_navigate` | pageId, url, operationId | text JSON | Navigate a page to an http(s) URL and wait for it to load. |
| `browser_observe` | pageId | text JSON | Get a semantic snapshot of the page: accessibility roles, names, form state and stable element refs. |
| `browser_operation` | operationId | text JSON | Reconcile a lost response using its operationId. |
| `browser_page_create` | operationId | text JSON | Create a page in an existing session, sharing its cookies and policy. |
| `browser_pages` | none | text JSON | List current pages in a session, including adopted popups, using server-generated page IDs. |
| `browser_pdf` | pageId | text JSON | Print the page to PDF and store it as a session artifact. |
| `browser_plan` | pageId, actions, operationId | urn:agentbrowser:plan-report:v1 | Execute explicit ordered steps in one server call. |
| `browser_screenshot` | pageId | text JSON | Capture a screenshot as optional evidence. |
| `browser_session` | none | text JSON | Inspect the delegated session control status and available pages. |
| `browser_snapshot` | pageId | text JSON | Read a self-contained page snapshot with current refs. |

## unbound/application (0 tools; 12 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |

## delegated/application (1 tool; 293 result bytes)

| Tool | Required arguments | Output contract | Purpose |
| --- | --- | --- | --- |
| `browser_operation` | operationId | text JSON | Reconcile a lost response using its operationId. |

Full nested schemas and complete descriptions are available through `tools/list`.
The digest detects changes even when a summary row stays the same. Tool errors retain
text diagnostics; failed valid reports retain their receipts and set `isError: true`.
Do not retry uncertain writes automatically. See the [MCP package guide](../packages/mcp-server/README.md).
