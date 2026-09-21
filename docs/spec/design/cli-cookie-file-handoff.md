# CLI cookie-file handoff

Status: released and qualified in 1.9.1; see the [delivery evidence](../evidence/release-1.9.1.md).
Load only for credential-handoff work. The existing
session-create API and SDK accept `SessionCookie[]`; the CLI retains compatible
inline JSON with `--cookies`. Local file input adds no new session
owner, browser adapter, or credential store.

## Contract and reuse

- Add `session create --cookies-file <path>`; default format is the JSON array emitted
  by `session cookies`. Keep `--cookies` compatible and reject simultaneous sources.
- Add explicit `--cookies-format json|netscape|chrome-devtools-tsv`. Do not infer a tabular
  format merely from its column count. Netscape and DevTools columns have different order.
- Add `session cookies <id> --output <path>` using existing cookie export. Secret values
  never appear in the default status output when a file destination is selected.
- Parse local files once in a bounded shared CLI input helper; normalize through small
  format adapters into the existing protocol schema. Reuse the same validation and
  diagnostics for all entry points. No server file path or format-specific API field.
- No credentials in process arguments for file input. Do not log bodies, cookie values,
  source lines, or unredacted parser exceptions. Errors identify row/field and reason.
- Before any session creation, enforce explicit byte/count limits, validate the complete
  input, and reject ambiguous duplicate name/domain/path entries and malformed attributes.
  Limit source input and the normalized create request to 1 MiB each, with at most 1000
  cookies. Reuse the existing CLI input bound without raising the server request limit.
  Oversized input cannot partially seed.

## Preserve security semantics

Preserve domain/host scope, path, expiry (including session cookies), Secure, HttpOnly
and SameSite. Honor existing engine handling of `__Host-` and `__Secure-` constraints.
Never widen domains or drop an attribute to make an import succeed. Optional explicit
domain filtering must produce counts of excluded cookies, without values.

The present protocol has no partition-key or cross-site-ancestor fields. A DevTools
export can contain these. Reject unsupported partitioned cookies by default, before
creating a session. Explicit `--cookies-skip-unsupported` may omit partitioned entries
with nonsecret counts; malformed entries still fail. Without this flag nothing is skipped;
never convert a partitioned cookie into an unpartitioned cookie. Supporting partitioned
cookies later requires a separate protocol/engine capability review and parity tests.

Expired entries are refused. Preserve session expiry (`expires: -1` in canonical exports,
zero in Netscape exports, and `Session` in DevTools exports). Reject unknown attributes
whose omission could change cookie scope. A seeded session does not prove website login:
verify the expected authenticated UI after navigation, with no automatic login retry loop.

Read input as a regular file under the caller's authority. Export with owner-only mode,
exclusive creation; no overwrite option ships in this slice. A failed write retains any
incomplete private file for explicit inspection/removal, avoiding pathname replacement
races during cleanup. Existing files and symlink
destinations are refused. Reject nonregular input using the shared bounded reader. Never stage
credential files in the repository, tests, snapshots, telemetry or public CI artifacts.

## Implemented tasks and acceptance

1. Audit existing bounded readers, local output helpers, protocol cookie schema, SDK
   create/export, and engine normalization. Document ownership; reuse before adding code.
2. Failing-first parser tests with synthetic cookies: JSON round trip, Netscape HttpOnly
   prefix, DevTools column mapping, timestamps/session expiry, empty values, Unicode,
   malformed rows, oversized input, duplicates, foreign domains and partition metadata.
3. Implement shared normalization and refusal diagnostics, then CLI file options/help.
   Test secret values never reach stdout/stderr or error strings; no session call on error.
4. Add one local HTTP cookie fixture: seed through packaged CLI, verify an authenticated
   response, export privately, reseed and verify again. Include expired/unsupported and
   server-refusal cases. No external account or Glassdoor cookies in CI.
5. Run focused tests and existing SDK/CLI/protocol compatibility checks locally, then a
   single reviewed PR through existing CI. Record exact supported formats and limitations.

This is an optional credential-handoff improvement for the
[job-application checkpoint](t6-job-application-checkpoint.md), not a new automation
framework or proof that every site accepts imported sessions. Format adapters belong to
the CLI, not a new service endpoint. The SDK retains the normalized cookie-array contract.
[TD-BROWSER-6](../../td/TD-BROWSER-6-headed-sessions-and-credential-handoff.md) and
[ADR-005](../../adr/005-ephemeral-sessions-explicit-persistence.md) own the underlying
explicit credential-handoff and persistence decisions.
