# T6 checked upload and application draft evidence

Base: develop `098d5ba46fc04ea216fbb5384cab7b600b07df51` after mapping PR #238.
Scope: [bounded design](../design/t6-verified-upload-draft.md). Published 1.9.1
remains unchanged. This record describes local candidate evidence; PR integration
and post-merge results must be verified separately before calling it delivered.

## Reused owners

The existing upload action gains optional digest/MIME metadata. Protocol constants
and cross-field validation are shared by wire, core and direct Playwright callers.
One engine helper reads bounded bytes and hashes the buffer supplied to both
Playwright upload branches. CLI flags forward the canonical request; existing
plans, SDK types, OpenAPI and optional MCP schemas reuse that contract. No new
endpoint, package, dependency, executor, ledger or workflow service was introduced.

## Falsifying evidence

Node 24.21.0, local temporary files and isolated Chromium; synthetic values only.

| Check | Observed evidence |
| --- | --- |
| Initial protocol negatives | 9 failed / 35 passed before digest/cardinality/MIME cross-field validation |
| Initial CLI flags | 1 failed / 113 passed because checked-upload flags did not exist |
| Initial real adapter probes | 7 failed / 3 passed before checked-buffer upload |
| Relative helper path | 1 failed / 19 passed before absolute-path rejection |
| Protocol and core | 46 wire cases and 37 executor cases pass; invalid metadata refuses before policy/engine I/O |
| Shared file helper | 22 pass: matching/empty/bounded files, detached bytes, sanitized errors, relative paths, symlinks/FIFOs, replacement and read instability |
| Real Playwright branches | 12 checked-upload and 24 legacy action-contract cases pass: targeted/untargeted exact bytes and MIME, mismatch without file events, ambiguous targets, malformed direct metadata |
| Full compiled-CLI draft | Initial failure at absent `--sha256`; final fixture passes mapping preparation, autofill, changed-file refusal, independently observed browser-file digest and denied submit |

Terminal-newline digest/MIME probes already passed before any implementation change;
they are additional contract coverage, not a claimed regression repair. Independent
working-tree review identified the relative-path helper gap; its failing-first fix
is included. Exact-head review and the normal hooks/CI remain delivery gates.

## Boundaries and next work

Only Playwright checked upload is qualified. Unsupported engines still refuse upload;
direct non-Playwright internal action entry points are not newly qualified for metadata
validation. A successful digest proves bytes supplied to the browser, not document
validity, safety, applicant truth or downstream acceptance. MIME is metadata only;
the PDF-like fixture bytes are not a PDF renderer/parser qualification.

The fixture checks app-owned field observations and browser `File` bytes. Its
submit counter remains zero under an explicit operator deny rule. It establishes
a deterministic draft boundary, not a complete job workflow. Page scripts may
transmit files on attachment; sensitive uploads need their own policy admission.
The local reader is byte-bounded, not a hard filesystem-latency isolation mechanism.

Existing submit approval binds action context, not all form answers, job identity
and PDF contents. Design and qualify that additional consent contract before live
automated submission. Candidate criteria/identity, source-grounded private resume
generation, conditional stages/manual fields, real ATS support and independent
submission receipts remain T6 work; durable recovery stays T5. No private resume,
cookies, logged-in browser or live application was used by this fixture.
