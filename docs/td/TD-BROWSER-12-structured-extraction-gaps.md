# TD-BROWSER-12: Structured Extraction Gaps on Real List Pages

**Status:** Observed live against 1.8.6 (`/extract` shipped earlier); gaps open
**Context:** 2026-09-08, Dice.com job-search result pages (≈30 card components
per page, each a nested anchor + sibling metadata), via the brew-installed
server
**Related:** [TD-BROWSER-10](TD-BROWSER-10-session-extension-loading.md)
(same testbed)

## What was tested

A real automation flow needed per-card structured data: title, URL, company,
location, posted date, and an "Easy Apply vs external" flag, for ~30 cards
per search page. Three paths were exercised on the same live page:

1. `POST /extract` `format: "links"` — returned 138 links in ~4s (the raw
   HTML export is ~450KB), with absolute URLs and rel. **But `text` came
   back empty for the card anchors**: Dice renders each card title inside
   nested elements under the `<a>`, and the extractor only collected the
   anchor's direct text. Half the needed data (URLs) arrived; titles did
   not.
2. `POST /extract` `format: "schema"` (flat JSON Schema, `title`, `company`,
   `location`, `posted`) — single-record semantics. On a list page it
   returned one record of cross-page junk ("company": "Principal" matched
   from the query string; "location": "Menlo" from a footer). Not a defect
   of the matcher so much as a mismatch of surface: schema mode fills one
   record per page; list pages need N records.
3. HTML export + client-side parsing — the only path that yielded complete
   card data, at the cost of ~450KB transfers (inline threshold forces an
   artifact round-trip above 256KiB), base64 decoding, and brittle
   regex-on-`data-testid` parsing living entirely outside the product.

## Gaps this exposes

- **Nested-element link text**: `links` should capture an anchor's visible
  text through wrapped children (one `innerText`-style read), not direct
  text nodes only. Likely a small fix with outsized real-world coverage —
  production card/list UIs almost always wrap the label.
- **No records/list extraction surface.** The missing middle ground between
  "one record per page" (`schema`) and "raw HTML" is something like
  `format: "records"` with a container selector + per-field relative
  selectors, returning `JSON[]` with the same evidence block (URL, revision,
  hash per record). CSS-selector-driven, deterministic, no model calls —
  consistent with the extractor design constraints.
- **Payload economics**: list-page automation currently pays for the full
  DOM to get a few hundred bytes of fields. A records mode (or even links
  with text) shrinks that by 3 orders of magnitude and removes the
  inline/artifact threshold dance.

## Notes for the fix

- Evidence per record should include the record's container ref so a
  follow-up act on that card reuses the observation identity instead of
  re-observing.
- Keep deterministic-first: a records mode is pure CSS-selector evaluation;
  no reason for the model adapter to participate.
- The `schema` mode's misfire is worth a docs warning: on multi-record pages
  it silently returns plausible-looking garbage. Consider detecting
  repeated container structures and refusing/warning instead.

## Non-goals

- Replacing the model-adapter path for unstructured pages.
- Site-specific parsers in the product; the surface stays generic.
