# Research consumer smoke: first compatibility packet

Status: local candidate validation before commit/PR; no release or installed-harness
qualification claimed. Base: develop `5ebf820`. Scope: R1–R3 in the
[consumer intake](../design/consumer-research-intake.md), derived from the
[field report](../../consumer-field-handoff-2026-09-24.md).

## Reproduce before publication

Build the workspace, then run:

```sh
node scripts/research-consumer-smoke.mjs --headed
```

Omit `--headed` for the same real Chromium exercise without visible windows. The
smoke reuses the existing release subprocess/MCP acceptance helpers, starts an
authenticated service and HTTP fixture on ephemeral loopback ports, and closes its
own sessions, servers and temporary files. It does not touch an existing service.
No external website or model call is required, and no large fixture is checked in.

## Observed large-document results

| Fixture | Source HTML bytes | Complete compact extraction bytes | Result |
| --- | ---: | ---: | --- |
| 13 MiB filing-shaped document | 13,631,488 | 1,408,355 | Headed MCP extraction, SDK equality, evidence and end-marker grep passed |
| 52 MiB filing-shaped document | 54,525,952 | 1,408,355 | Headed MCP extraction, SDK equality, evidence and end-marker grep passed |
| Submissions-shaped JSON | 210,051 | Below the configured ceiling | JSON content/end marker retained through navigation and extraction |

The fixture includes comment padding and visible financial-style text containing
Unicode and quotes. It is a size/serialization fixture, not a reproduction of SEC's
DOM complexity. The service ceiling is explicitly 2 MiB. Requests at 1 MiB fail with
`OUTPUT_TRUNCATED` and no partial content. Repeated SDK/MCP extraction preserves the
complete result and source hash/revision. This verifies a script-owned file/grep
workflow, not Claude's independent overflow writer or path convention.

## Additional acceptance in the same smoke

- Explicit second-page creation, service-generated IDs, inventory and shared cookies;
  a separately created session has a distinct cookie jar.
- Invented page navigation fails without creating another page.
- Invalid URL creation fails before allocation; failed navigation leaves no registered
  page. Closing the second page preserves its sibling.
- Resolved redirects retain final URLs; an HTTP 503 maintenance document can still be
  read as a loaded page. Neither case is classified as a proven bot wall.
- An actual delegated grant creates a page with a known operation ID. Repeating the
  same operation does not allocate another page; operation status has no page-result
  correlation. A conflicting body under that ID is refused without another allocation.
  After operator takeover, the old MCP grant cannot list or create pages.

The engine regression first demonstrated `status: success` at
`chrome-error://chromewebdata/`. The fix returns a non-retryable `INTERNAL` error with
static reason `browser_error_document`, preserving explicit policy denials and
ordinary loaded HTTP error pages. Unit tests inject the resolved driver result;
this does not claim to reproduce Yahoo's cause or availability.

## Live sample and independent review

A separate, paced headed probe used the candidate's authenticated SDK/REST service
with private/loopback/metadata egress blocked and a session host allowlist:

| Site | Observed result |
| --- | --- |
| `data.sec.gov/submissions/CIK0000320193.json` | Verified Apple CIK and parsed submissions; 188,627 result bytes, hash `f07f7066` |
| SEC primary 10-Q, accession `000032019326000020`, `aapl-20260627.htm` | Financial statements and management discussion verified; 96,150 result bytes, hash `981a5271` |
| Yahoo TRV key statistics | `INTERNAL` with `reason: browser_error_document`; no false success or automatic retry |

These are one live sample, not an availability promise or an attribution of the
wall's cause. The primary filing was selected from submissions data; no page content
was treated as instructions. Only the probe's owned session/service was closed.

One intermediate local smoke failed on its first navigation before the test retained
the tool error details. Its cause is unknown. The assertion now retains fixture
navigation diagnostics; the final diagnostic run and an independent reviewer-run
headed confirmation passed. Do not relabel the earlier failure as explained.

Independent adversarial review found no remaining blockers after fixes to catalog
fixtures and the actual delegated-grant acceptance. Local validation before commit:
154 MCP tests, 27 release/catalog tests, two navigation regressions, workspace type
checks and lint, documentation links and 82 context selections. The normal commit
hook remains required. No new GitHub runner was used for these smoke exercises.

## Boundaries and remaining gates

No extraction ceiling was removed, no new executor/session manager introduced, and
no automatic navigation/create replay added. General page-count limits, uncertain
create result correlation, launch diagnostics, public close causes, profile reuse,
repeatable live-site qualification and installed Claude overflow remain separate gates.
The local API/MCP versions report the existing 1.10.1 package version; these changes
are unreleased source changes, not evidence that installed 1.10.1 contains them.
