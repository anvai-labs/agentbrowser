# Recipe: SEC EDGAR filings research

Public-company filing research (10-K/10-Q inventories, segment metrics,
reserve commentary) runs almost entirely against SEC's machine endpoints.
The human-facing `browse-edgar` pages throttle aggressively; everything
below avoids them. Verified end-to-end on 2026-09-24 across a 14-company
insurance/semiconductor sweep (inventories, full 10-Q/10-K document reads,
and earnings 8-K extraction) without a single throttle response on the
recommended path.

## Use the machine endpoints, not the HTML pages

| Need | Endpoint |
| --- | --- |
| Filing inventory for one issuer | `https://data.sec.gov/submissions/CIK##########.json` |
| Full-text search (which filing says X) | `https://efts.sec.gov/LATEST/search-index?q=…&forms=…&ciks=…` |
| Primary document | `https://www.sec.gov/Archives/edgar/data/<cik-no-leading-zeros>/<accession-without-dashes>/<filename>` |

The inventory JSON is ~190 KB and renders as text; the FTS API returns
compact JSON whose hit `_id` is `<accession>:<filename>` — that pair
builds the primary-document URL directly, no directory listing needed.
Keep to roughly one request per second; the throttling observed on
`browse-edgar` never appeared on these endpoints under that pace.

## Large documents: load, extract, grep locally

A modern 10-K is a single 10–52 MB HTML file. The browser loads it fine;
the failure mode is trying to read the whole text into a response.
Instead: `browser_extract` the loaded page (the result overflows to a
persisted output file above the size limit), then grep the saved file
locally for the MD&A phrases you need (`combined ratio`, `prior year
reserve development`, `gross margin`, `capital expenditures`). This
turns a 50 MB filing into a 300 KB text file queried with `grep`/`jq` —
no pagination, no truncation.

## Earnings metrics without reading MD&A

Segment metrics (combined ratios, reserve development, book value) ship
in the earnings 8-K press release — far smaller than the 10-Q and filed
the same day. Find it with full-text search scoped to the quarter:

```
https://efts.sec.gov/LATEST/search-index?q=%22combined+ratio%22&forms=8-K&ciks=<cik>&dateRange=custom&startdt=2026-07-01&enddt=2026-09-24
```

The hit's `_id` gives `accession:filename`; the press release renders
and extracts like any page.

## Amendments

Check for amendments across the whole peer set in one query:
`forms=10-K/A` with `q=insurance` (or any word certain to appear) over
the review window. An issuer absent from the hits has no amendment in
the window — one query replaces per-company checks.

## Worked shape (from the 2026-09-24 run)

1. `submissions` JSON per issuer → confirm FY 10-K + quarterly 10-Q
   cadence and capture accession numbers (also answers "any
   amendments?").
2. FTS per issuer for the newest 10-Q/8-K document path.
3. Navigate the primary document; extract; grep the MD&A phrases.
4. Valuation cross-check from a market-data source of your choice, then
   reconcile every extracted figure against the filing before citing it.

## Pitfalls

* `browse-edgar` intermittently serves its maintenance page even when
  the machine endpoints are healthy — switch endpoints, don't retry.
* CI-style environments resolve nothing for dead domains and some
  bot-walled hosts refuse automation outright; treat a failed navigation
  as unclassified until you have checked DNS separately (typed failure
  reasons for these cases are on the roadmap — see the consumer field
  handoff, Brief 1).
* A consent-walled issuer page (proxy-vote materials) needs the
  cookie-seeding handoff (ADR-013); filings themselves never do.
