# T3: private report artifact links

Status: merged through PR #229 at develop `7c452b1`, following PR #227 and the Node 24
baseline (#228). Later [T3 completion](../evidence/t3-standalone-qualification.md)
records the current delivery status; qualification statements below retain slice scope.
See [qualification and delivery boundary](../evidence/t3-report-artifacts.md).
Load only for this artifact slice; [T3](../tasks/t3-qa-regressions.md) remained active
at its delivery.

## Decision and ownership

Keep the canonical evaluation at the application's existing `reportPath`. Write a
bounded private sibling `<reportPath>.manifest.json` after the evaluation file closes.
The manifest contains a relative encoded filename, JSON media type, byte length and
SHA-256 of the exact evaluation bytes, plus the separately observed `oracleMatches`
boolean. Native Node diagnostics print only the fixed label and evaluation digest.
A user can associate a failed test with its report without exposing local paths,
request values, receipts or credentials in reporter output.

This is an example-local artifact convention, not another product protocol or API.
The installed CLI remains the canonical evaluator. The manifest does not duplicate or
recompute the case verdict; Node still requires both canonical success and a matching
independent oracle. A digest detects mismatched bytes, not malicious replacement of
both files, freshness, authorization or attestation. Retained reports remain private
and caller-observed. They are not input bundles for re-evaluation and must not be
uploaded as public CI artifacts. HTML rendering and remote artifact retrieval remain
out of scope; no need for another renderer has been established.

## Common helper and publication

One builtins-only helper beside the standalone recipe owns bounded private reads,
exclusive report/manifest writes and byte-link validation. Both the recipe and the
existing package qualification consume it. Copy both example modules together; no
workspace dependency or MCP connection is needed. Reuse the reader for recipe config
and remove the acceptance wrapper's duplicate private report reader.

The application owns a private, non-concurrently-mutated parent directory. Both output
names must be unused. Writes use exclusive creation and mode 0600, never follow an
existing output link, and track only files created by this invocation. The manifest
is written last. A reader requires both complete bounded files and matching metadata;
a report alone, partial manifest or mismatch cannot qualify an artifact pair. Failure
or handled abort removes only this invocation's newly created files. Existing files
are preserved. Hard-kill/power-loss recovery and hostile parent-directory replacement
remain outside this process-local ownership guarantee (T5 remains open).

Readers derive both paths from the trusted owner-supplied report path; they never
resolve or fetch the manifest's href. They reject links, non-regular files, non-private
POSIX permissions, oversized data, malformed JSON, extra manifest keys and wrong
media type/size/hash/href. A single bounded read avoids unbounded allocation if a file
grows. Errors and diagnostics contain no file content or owner-supplied path.

## Qualification

Failing-first helper controls cover pass/fail retention, oracle mismatch preservation,
byte tampering, wrong link metadata, path-like filenames, symlinks, invalid permissions,
size bounds, collisions and abort cleanup without deleting pre-existing outputs.
The existing three fresh application cases must emit the same native digest link,
retain unchanged canonical reports and oracle observations, and leave no output files
after their enclosing finalizer. The original 13-case matrix and native red JUnit
controls remain unchanged. No service/browser startup, job, dependency, public command
or schema is added. Qualify locally, review the exact commit, run existing CI and
verify the develop merge. Release promotion is a later checkpoint.
