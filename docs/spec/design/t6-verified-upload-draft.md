# T6: verified upload bytes and application draft qualification

Status: bounded implementation slice after mapping PR #238. No release or live
application acceptance follows. Load with the forms packet and
[job checkpoint](t6-job-application-checkpoint.md), not every agent mode.

## Problem and acceptance boundary

An upload receipt with a filename and size cannot prove it attached the PDF the
caller reviewed. Hashing a path and later handing that path to the browser leaves
a replacement race. Existing submit approvals bind an action and target context;
they do **not** bind all form answers, job identity and attached file bytes.

Close the first gap with an opt-in upload contract, then qualify a synthetic
application **draft** through compiled CLI commands. Keep final submission denied.
This establishes composition evidence for existing owners without claiming
reviewed-payload consent, live ATS support or an accepted application.

## Contract and shared owners

Extend existing `act upload` / `/act` / plan steps, without another endpoint:

```json
{
  "action": "upload",
  "paths": ["/absolute/service-host/resume.pdf"],
  "sha256": "<64 lowercase hexadecimal characters>",
  "mimeType": "application/pdf"
}
```

`sha256` opts into exactly one regular file, at most 16 MiB. `mimeType` is optional
metadata, requires `sha256`, and defaults to `application/octet-stream`; it does
not inspect PDF structure or prove content type. Accept bounded type/subtype
syntax without parameters. Empty files are allowed when their digest matches;
document suitability belongs to the caller. Without either new field, preserve
existing path-based and multiple-file upload behavior.

The protocol owns the constants, schema fields and cross-field validation. Reuse
that validation in wire/plan decoding, core and direct engine calls. Invalid
metadata must fail before browser effects. SDK types and CLI schema discovery
derive from the existing wire contracts; MCP remains an optional plan adapter.

`@agentbrowser/engine` owns one bounded filesystem helper. The Playwright adapter
calls it after existing policy checks and passes its detached bytes to
`setInputFiles` in both targeted and untargeted branches. Do not pre-hash in core,
then pass a mutable path, or add a second upload client/executor. No dependency is
needed beyond Node filesystem/crypto APIs.

1. Validate input; `lstat` the path and refuse symlinks/special files.
2. Open read-only with `O_NOFOLLOW | O_NONBLOCK`; compare descriptor identity with
   the observed file. `fstat` must show a regular file within the byte cap.
3. Read bounded bytes through that descriptor, detect truncation/growth with an
   overflow probe and final metadata check, and always close the handle.
4. Hash the detached buffer and compare the expected digest. Supply that same
   buffer, basename and MIME metadata to the browser; never reopen by path.
5. Include computed SHA-256 alongside size/name in the successful file receipt.

Missing, replaced, oversized, unstable or mismatched files fail with sanitized
`INVALID_REQUEST`. No local path or contents enter that error. Digest equality
proves byte identity to the caller's supplied digest, not trust in the caller,
document safety, applicant truth, or downstream application acceptance. This
adds no filesystem access beyond the existing upload authority. The operation
ledger may conservatively retain dispatch uncertainty after policy admission;
do not infer a safe retry solely from an error response.

## CLI and remote use

```sh
agentbrowser act upload SESSION PAGE /service-host/resume.pdf \
  --sha256 EXPECTED_SHA256 --mime-type application/pdf
```

The path belongs to the service host, including for remote CLI callers. This is
not a client-to-server file transfer. Reuse CLI help and `describe act upload`
for flags, and `describe plan --schema` for the canonical JSON fields. Buffer MIME metadata
can differ from legacy path inference, so qualify `application/pdf` explicitly.
Other engines cannot advertise checked upload without byte-delivery evidence.

## Failing-first qualification

- Protocol/CLI: malformed/uppercase digest, multiple paths, MIME without digest,
  metadata on other actions, and unsafe/oversized MIME fail before service calls.
  Legacy single/multiple paths and targeted parsing remain compatible.
- Shared helper/adapter: mismatch, oversize, symlink, FIFO, replacement and read
  instability fail without `setInputFiles` or revision changes; matching bytes
  are passed exactly once. Mutation of the source after reading cannot change
  the supplied buffer. Cover targeted, untargeted and ambiguous targets.
- Real Chromium/CLI: prepare a synthetic mapping, run existing autofill, attach
  a synthetic PDF with its expected digest, and independently inspect the app's
  received browser `File` bytes. Changed bytes refuse without a new upload event.
  Operator policy denies final submit and an independent submit counter stays zero.

Keep fixtures public-safe, local and deterministic. Reuse the current CLI child
runner, server/session authority, mapping join, autofill and action owners. Do not
invent a workflow DSL, alternate operation ledger or site-specific engine fork.

## Follow-ups and stopping rule

This completes only the bounded upload/draft gate. T6 remains active: full payload
consent binding, candidate eligibility/identity, private source-grounded resume
generation, conditional stages/manual controls, live portal qualification and
independent submission receipts remain separate work. T5 owns durable recovery.
Do not auto-replay approval challenges as evidence of human payload review.

Use one PR to develop after local gates and independent exact-head review; verify
PR and post-merge CI. Keep published 1.9.1 immutable and checkpoint a later release
when a usable workflow boundary is qualified.
