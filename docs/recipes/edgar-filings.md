# Research SEC EDGAR filings

Use EDGAR's machine-readable endpoints for company and filing discovery. Use the
archive URL only after you have an exact CIK, accession number, and filename. The
legacy `browse-edgar` CGI is a fallback because it can return maintenance or rate-limit
pages even when the JSON endpoints are available.

## Respect the SEC access boundary

Read the SEC's [Accessing EDGAR Data guidance][sec-access] before running a scripted
workflow. At authoring time it required automated clients to declare a `User-Agent`
with an organization and contact address, limited aggregate traffic to 10 requests per
second, and asked clients to download only what they need. This recipe deliberately
paces at about one request per second.

AgentBrowser does not currently expose a startup-owned custom browser `User-Agent`.
Therefore, use a declared-identity HTTP client for automated SEC collection. The
AgentBrowser commands later on this page record a headed, one-off qualification run;
they do not make the browser's default Chrome identity compliant for scheduled or bulk
EDGAR access.

Set a real monitored contact before making a request. Do not copy the placeholder:

```bash
export SEC_USER_AGENT='Your Organization research-ops@your-domain.example'
: "${SEC_USER_AGENT:?Set an organization and monitored contact address}"
case "$SEC_USER_AGENT" in
  *your-domain.example*) printf '%s\n' 'Replace the SEC_USER_AGENT placeholder' >&2; exit 2 ;;
esac
mkdir -p edgar-work

# Expected after replacing the placeholder: setup exits 0 with no output.
```

Stop on `403`, `429`, a maintenance page, or repeated `5xx` responses. Wait before a
bounded retry; do not rotate identities, parallelize around the limit, or treat an SEC
error document as filing data. EDGAR's public filing endpoints do not require an
application login. If a consent, fair-access, or other interstitial appears, inspect
and comply with it; do not automate around it.

## Resolve tickers to official CIKs

Fetch the SEC ticker map once, then derive the zero-padded CIKs from that source. Do
not guess a CIK from memory.

```bash
curl --fail --location --silent --show-error \
  --user-agent "$SEC_USER_AGENT" \
  --output edgar-work/company_tickers.json \
  https://www.sec.gov/files/company_tickers.json

jq -r '
  .[]
  | select(.ticker == "TRV" or .ticker == "HIG" or .ticker == "ALL")
  | [.ticker, .cik_str,
     (("0000000000" + (.cik_str | tostring))[-10:]), .title]
  | @tsv
' edgar-work/company_tickers.json

# TRV  86312   0000086312  TRAVELERS COMPANIES, INC.
# ALL  899051  0000899051  ALLSTATE CORP
# HIG  874766  0000874766  HARTFORD INSURANCE GROUP, INC.
```

## Build a filing inventory

`data.sec.gov/submissions/CIK##########.json` exposes recent filings as parallel
arrays. Bind the `recent` object once and index every field with the same `$i`; applying
an independent filter to each array can silently join unrelated filings.

```bash
for cik in 0000086312 0000874766 0000899051; do
  sleep 1
  curl --fail --location --silent --show-error \
    --user-agent "$SEC_USER_AGENT" \
    --output "edgar-work/${cik}-submissions.json" \
    "https://data.sec.gov/submissions/CIK${cik}.json"
done

jq -r '
  .filings.recent as $r
  | range(0; ($r.form | length)) as $i
  | select($r.form[$i] == "10-K"
        or $r.form[$i] == "10-Q"
        or $r.form[$i] == "8-K")
  | [$r.form[$i], $r.filingDate[$i],
     $r.accessionNumber[$i], $r.primaryDocument[$i]]
  | @tsv
' edgar-work/0000086312-submissions.json | head -12

# 8-K   2026-08-07  0001104659-26-092716  tm2622405d1_8k.htm
# 8-K   2026-07-24  0001193125-26-316247  d659242d8k.htm
# 10-Q  2026-07-17  0000086312-26-000145  trv-20260630.htm
# 8-K   2026-07-17  0000086312-26-000143  trv-20260717.htm
```

The recent arrays are an inventory, not a full-text index. An 8-K's
`primaryDocument` is often the short cover form; the useful earnings release is
usually an EX-99.1 exhibit.

## Find the filing document with full-text search

Use the EDGAR full-text-search endpoint to locate an exhibit containing the phrase of
interest. Save the complete JSON response before parsing it. This example is a bounded
100-hit sample for three companies and one date interval, not an exhaustive result set.
For an exhaustive search, advance `from` by `size`, retain every response page, stop at
an empty page, and keep the same pacing.

```bash
fts_url='https://efts.sec.gov/LATEST/search-index?q=%22combined%20ratio%22&forms=8-K&dateRange=custom&startdt=2026-01-01&enddt=2026-09-25&from=0&size=100'
sleep 1
curl --fail --location --silent --show-error \
  --user-agent "$SEC_USER_AGENT" \
  --output edgar-work/combined-ratio-search.json \
  "$fts_url"

jq -r '
  .hits.hits[]
  | select(any(._source.ciks[]?;
      . == "0000086312" or . == "0000874766" or . == "0000899051"))
  | (._id | capture("^(?<accession>[^:]+):(?<filename>.+)$")) as $hit
  | (._source.ciks[0] | tonumber | tostring) as $cik
  | [._source.file_date, ._source.ciks[0], $hit.accession, $hit.filename,
     "https://www.sec.gov/Archives/edgar/data/\($cik)/\($hit.accession | gsub("-"; ""))/\($hit.filename)"]
  | @tsv
' edgar-work/combined-ratio-search.json \
  | rg 'a991pressrelease63026|ex991earningsnewsrelease63|allcorp63026'

# 2026-07-17 ... TRV .../a991pressrelease63026.htm
# 2026-07-23 ... HIG .../ex991earningsnewsrelease63.htm
# 2026-08-05 ... ALL .../allcorp63026earningsreleas.htm
```

The `_id` grammar is `accession:filename`. Split on the first colon, remove dashes
from the accession only, and convert the padded CIK through a number before placing it
in the archive path. Removing a single leading zero produces a plausible but wrong
URL.

## Download once, then search locally

Earnings 8-K EX-99.1 releases are compact carriers for segment metrics. Download the
three exact hits sequentially and search local files instead of repeatedly contacting
the SEC.

```bash
cat > edgar-work/releases.tsv <<'EOF'
TRV	https://www.sec.gov/Archives/edgar/data/86312/000008631226000143/a991pressrelease63026.htm
HIG	https://www.sec.gov/Archives/edgar/data/874766/000087476626000059/ex991earningsnewsrelease63.htm
ALL	https://www.sec.gov/Archives/edgar/data/899051/000089905126000117/allcorp63026earningsreleas.htm
EOF

while IFS=$'\t' read -r ticker url; do
  sleep 1
  curl --fail --location --silent --show-error \
    --user-agent "$SEC_USER_AGENT" \
    --output "edgar-work/${ticker}-release.html" "$url"
done < edgar-work/releases.tsv

for ticker in TRV HIG ALL; do
  printf '%s\n' "== $ticker =="
  rg -io '.{0,80}combined ratio.{0,120}' \
    "edgar-work/${ticker}-release.html" | head -3
done

# TRV: consolidated 83.6%; underlying 84.1%.
# HIG: Business Insurance 91.4; underlying 89.3.
# ALL: Property-Liability recorded 86.6; underlying 79.4.
```

These values are observations from the cited 2026 releases, not a stable schema or a
current financial recommendation. Keep the filing date and source URL with extracted
metrics.

For a large primary filing, keep the same file-first pattern. The authoring run fetched
the HIG 2025 10-K as about 10.26 MB of browser HTML and searched it locally:

```bash
sleep 1
curl --fail --location --silent --show-error \
  --user-agent "$SEC_USER_AGENT" \
  --output edgar-work/HIG-2025-10-K.html \
  https://www.sec.gov/Archives/edgar/data/874766/000087476626000012/hig-20251231.htm

wc -c edgar-work/HIG-2025-10-K.html
rg -io '.{0,80}combined ratio.{0,120}' \
  edgar-work/HIG-2025-10-K.html | head -3

# 10168018 edgar-work/HIG-2025-10-K.html (authoring-time HTTP response size)
```

## AgentBrowser qualification transcript

The 2026-09-25 authoring run used one headed, dedicated session and one page. Every SEC
navigation below returned `status: success`. The same URLs had separate HTTP status
observations recorded below; those checks used a synthetic authoring contact and do not
qualify production use. Replace the opaque IDs with values returned by your local
service.

```bash
base_url=http://127.0.0.1:5709
session_json=$(agentbrowser --base-url "$base_url" --json session create \
  --tenant edgar-recipe --no-headless --idle-timeout 3600000)
session_id=$(jq -r .sessionId <<<"$session_json")
page_id=$(agentbrowser --base-url "$base_url" --json page create "$session_id" \
  | jq -r .pageId)

agentbrowser --base-url "$base_url" --json navigate "$session_id" "$page_id" \
  https://data.sec.gov/submissions/CIK0000086312.json \
  --wait-until domcontentloaded

# {"status":"success","url":"https://data.sec.gov/submissions/CIK0000086312.json",...}
```

Large page HTML uses the existing artifact contract, so terminal or harness output
limits do not cut the document. `--no-print` returns a descriptor; `artifact get
--out` writes caller-owned bytes. Do not depend on a harness-specific overflow path.

```bash
agentbrowser --base-url "$base_url" --json navigate "$session_id" "$page_id" \
  https://www.sec.gov/Archives/edgar/data/874766/000087476626000012/hig-20251231.htm \
  --wait-until domcontentloaded

artifact_json=$(agentbrowser --base-url "$base_url" --json page html \
  "$session_id" "$page_id" --no-print)
artifact_id=$(jq -r .artifactId <<<"$artifact_json")
agentbrowser --base-url "$base_url" --json artifact get \
  "$session_id" "$artifact_id" --out edgar-work/HIG-2025-10-K.browser.html
rg -io '.{0,80}combined ratio.{0,120}' \
  edgar-work/HIG-2025-10-K.browser.html | head -3

agentbrowser --base-url "$base_url" --json session close "$session_id"

# Authoring evidence: artifact size 10,259,307 bytes; local grep returned matches.
```

This transcript is a product compatibility check. Until AgentBrowser has a trusted
startup setting for a declared SEC automation identity, use the declared-identity HTTP
lane for actual scripted collection.

## Keep `browse-edgar` as a last resort

The equivalent company-search URL is:

<https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000086312&type=10-K&dateb=&owner=exclude&count=40&output=atom>

It returned `200` during this authoring pass, but the 2026-09-24 field run intermittently
received an SEC maintenance page from the same interface. A `200` transport status does
not prove that the body is a filing inventory. Prefer submissions JSON, inspect the
response body, and stop if it contains maintenance or fair-access text.

## Authoring-time link evidence

Checked on 2026-09-25, sequentially at about one request per second. “Browser” means
AgentBrowser headed navigation completed at the exact URL. “HTTP” used the same
declared-identity header shape as the recipe; the authoring contact was synthetic and
is not a substitute for the reader's real monitored address. A generic repository-only
agent string returned `403` for FTS, archive, browse, and guidance URLs in a separate
pass. That response variation does not establish its cause or production qualification;
the independent requirement for a real declared contact comes from the SEC guidance.

| URL group | Browser | HTTP | Observation |
| --- | --- | --- | --- |
| [SEC access guidance][sec-access] | success | 200 | Current policy text loaded |
| [Company ticker map](https://www.sec.gov/files/company_tickers.json) | success | 200 | TRV/HIG/ALL CIKs present |
| [TRV submissions](https://data.sec.gov/submissions/CIK0000086312.json), [HIG submissions](https://data.sec.gov/submissions/CIK0000874766.json), [ALL submissions](https://data.sec.gov/submissions/CIK0000899051.json) | success | 200 each | Recent arrays parsed |
| [Combined-ratio FTS query](https://efts.sec.gov/LATEST/search-index?q=%22combined%20ratio%22&forms=8-K&dateRange=custom&startdt=2026-01-01&enddt=2026-09-25&from=0&size=100) | success | 200 | `_id` parsed as `accession:filename` |
| [TRV EX-99.1](https://www.sec.gov/Archives/edgar/data/86312/000008631226000143/a991pressrelease63026.htm), [HIG EX-99.1](https://www.sec.gov/Archives/edgar/data/874766/000087476626000059/ex991earningsnewsrelease63.htm), [ALL EX-99.1](https://www.sec.gov/Archives/edgar/data/899051/000089905126000117/allcorp63026earningsreleas.htm) | success | 200 each | Combined-ratio text present |
| [HIG 2025 10-K](https://www.sec.gov/Archives/edgar/data/874766/000087476626000012/hig-20251231.htm) | success | 200 | 10.26 MB browser HTML artifact |
| `browse-edgar` fallback above | success | 200 | Available in this pass; intermittent maintenance observed previously |

Endpoint availability is not guaranteed. Re-run the checks with your declared identity
at the start of a research job, and preserve failures as evidence rather than retrying
until a block disappears.

[sec-access]: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
