# Navigation failure classification qualification

Status: candidate source after develop PR #292, unreleased. See the
[design](../design/navigation-failure-reasons.md). Source reports the existing
1.11.0 product version; this record does not claim those installed binaries contain
these changes. The background service is healthy on 1.11.0 and was not restarted.

## Failing-first evidence

Missing helper/schema tests failed first. Route regressions then failed 9/9:
resolver reason loss, origin-header spoofing and native failure details. Policy
reason test failed with 49 existing tests passing. The REST test failed because the
service dropped the routed reason. CLI/MCP tests each failed three new expectations
before their shared projections were implemented.

Independent review found and falsified lost operationId, stale public revision after
failed navigation and connection/URL text misclassified as engine death. Repairs
reuse the existing operation-ID schema through a neutral module, invalidate engine
and public refs at dispatch, and admit only driver-owned navigation close prefixes.
The named-reason vocabulary adds `dns_unresolved` and `connection_refused` rather
than asserting DNS facts the observed transport cannot establish.

## Consumer replay

Command (fresh source-built isolated service and headed Chrome):

```bash
node scripts/navigation-consumer-smoke.mjs --headed --live
```

The script drives real authenticated REST, SDK, CLI and MCP clients, records each
outcome and closes only its own session/service/fixture. The first replay verified
all four surfaces agreed: spoofed origin headers loaded normally, the unlisted LAN
host was denied, unresolved names failed, and the Monte Carlo homepage, Yahoo page
and allowlisted lab loaded. Yahoo did **not** reproduce its historical browser-error
document. This is not evidence that bot walls are absent or bypassed. The final replay passed with the following observed outcomes on all four surfaces.

Synthetic fixtures are deterministic assertions. Public-site DNS/content/availability
are time-dependent observations; no historical response is manufactured. Browser
error document and TLS cases are also pinned independently from live site behavior.
The broader headed research smoke remains the extraction/session regression gate.

| Target | Final REST / SDK / CLI / MCP outcome |
| --- | --- |
| Local origin returning 502 and spoofed policy headers | success (ordinary HTTP content) |
| Unlisted LAN `192.168.1.90` | egress_policy |
| Reserved `.invalid` hostname | dns_unresolved |
| `https://docs.montecarlodata.com/docs/` | dns_unresolved |
| `https://www.montecarlodata.com/` | success |
| Yahoo TRV key statistics | success |
| Allowlisted `http://192.168.1.89:8080/` | success |

Real self-signed HTTPS behind the configured route.fetch path separately reports
`tls_refused`; the untrusted origin receives zero HTTP requests. Static test fixture
material adds no runtime tooling dependency. The broader headed research smoke also
passes: 13/52 MiB pages, 1,408,355-byte complete result for each, unchanged evidence
hashes `3037b776`/`08333a65`, plus JSON/cookies/pages/lease and delegated behavior.
Targeted service/API regressions pass 197/197. Normal full hooks and exact-head CI
remain delivery gates, not inferred from these focused results.
