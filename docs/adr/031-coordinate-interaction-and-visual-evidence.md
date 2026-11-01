# ADR-031: Coordinate interaction and capture-bound visual evidence

Status: Accepted for the approved T10 A1 increment (2026-10-31); independent
review required before merge. Related: [ADR-007](007-approval-tokens-side-effects.md),
[ADR-015](015-cross-package-contract-single-source-of-truth.md),
[ADR-018](018-upload-action.md), [ADR-028](028-operator-asset-scope-amendments.md).

## Decision

Add typed coordinate click and coordinate file-chooser upload actions. CLI
`act click --at X,Y` selects explicit viewport CSS coordinates without a ref.
An image-coordinate option binds the point to a recent viewport screenshot capture.
Neither action exposes selectors, arbitrary JavaScript or raw CDP to agents. Ref
clicks keep their existing meaning. Keyboard input can operate the resulting focus.

Coordinate input has no semantic target from which to infer transaction risk.
It therefore requires an explicit one-use action approval, composed with operator
and session denies and existing credential-review floors. The approved identity
includes the engine allocation, page/main-frame, immutable loader/document identity,
authority epoch, complete point/gesture and viewport/zoom/scroll metrics; image
input also names its capture. Rules that allow generic unknown actions and unknown
action leases do not bypass this one-use consent. Partial down/up or attachment
results stay uncertain; they never authorize a retry. Controlled mutation admission, operation IDs and durable act
journaling remain the existing paths. No silent fallback or uncertain write replay.

Capture metadata reports actual raster dimensions, CSS viewport extent, DPR,
visual scale/offset, scroll, timestamp and an opaque capture ID. Mapping uses the
actual delivered raster/CSS extent rather than multiplying DPR twice.
For an untransformed viewport PNG, image point (px, py) maps to
(x, y) = (px × cssVisualWidth / rasterWidth, py × cssVisualHeight / rasterHeight).
Use cssLayoutViewport/cssVisualViewport, not deprecated device-pixel metrics.
Reported browser page zoom is recorded in the metrics; unknown/non-unit page zoom,
non-unit pinch scale or nonzero visual-viewport offsets initially refuse until a receiver oracle qualifies their
transform. Cropped, full-page, externally resized/downscaled or unknown-transform
images do not authorize mapped input. The caller's image dimensions must agree
with the delivered capture. CSS-coordinate input does not reinterpret image pixels. Full-page exports do
not authorize viewport clicks. Capture ownership is per engine page; retain at
most four for at most sixty seconds, without a separate persistent pixel cache.
Resizes, zoom/scroll changes, navigation, unknown/out-of-bounds points and stale
capture IDs refuse before input. Image-bound clicks also compare a fresh viewport
capture to the referenced image before dispatch; dynamic pages may need a fresh
capture. Explicit CSS-coordinate input acknowledges the lack of a semantic target.

The engine revalidates the captured document/metrics and live authority immediately
before compositor input, after asynchronous setup. Late setup cannot dispatch after
its deadline. Upload listens for exactly one chooser opened by that approved click,
requires a single regular file with mandatory SHA-256 integrity and a 16 MiB
ceiling, read once into the same detached verified buffer bound to approval. Never
reopen a mutable path after consent. A changed file fails integrity before dispatch.
It never clicks again if no chooser arrives. Serialize page input while preparation
and dispatch are live; refuse concurrent/competing input, multiple choosers, changed
document/frame/origin, and expired/revoked ownership. Remove listeners and discard
buffers on refusal/revoke once outstanding browser writes settle; a timed-out write
retains page exclusion until its underlying promise settles. Close zeros retained
buffers immediately. Each asynchronous read has a monotonic deadline and observes
page, document and owner cancellation; late reads cannot resume input. Errors after
submission preserve their typed cause and carry `dispatch: uncertain`; a late chooser gets no files.
A generic chooser event alone does not attest click causality. The first increment accepts only a native file input or a label with a uniquely
resolved native control at the approved point. Capture and recheck its Chromium
backend-node ID, owning main frame and loader. Match the browser's chooser-opened
backend-node/frame evidence and require one page chooser. The Playwright chooser
listener suppresses the OS picker and supplies diagnostics; its independently
ordered handle never chooses the attachment target. Resolve the approved backend
node in an isolated world, revalidate document/authority and chooser counts after
asynchronous setup, and deliver the verified buffer directly to that native input.
The fixed native setter emits synthetic `input`/`change` events, as buffer uploads
do; attachment does not claim trusted file events or application acceptance.
Native hit testing currently requires integral CSS coordinates and the main frame.
A custom button whose arbitrary callback selects an unknown input refuses; event
order alone never supplies target identity. This supports a closed-shadow native
file-input/label fixture without exposing DOM selectors or raw CDP to the caller.
Serialize engine page input across preparation/dispatch, reject conflicting actions,
and invalidate on navigation/close/revoke. External/manual input causality is not
attested; identity-bound delivery to the explicitly approved native input is the
qualified contract. Ambiguous or unattestable attachment lanes refuse. All resulting traffic still crosses the same policy and ledger.
An operator CDP session retains its existing explicit unenforced-egress diagnostic.

## Visual verification and discovery

Compare bounded viewport screenshots before and for up to one second after a
click. Report observed change, no visible effect (with a loud swallowed-click
warning), or unavailable verification. Visual change is evidence of presentation,
not proof a remote operation committed. A no-effect result never triggers a replay.
Keep semantic action results compatible while making the warning visible through
CLI/MCP and structured results.

When semantic observations contain very few controls, expose an advisory visual
interaction diagnostic. Positive closed-root evidence may identify closed shadow
DOM; an empty tree plus rendered pixels alone cannot distinguish closed roots,
canvas or inaccessible frames and must say so. Detection is bounded and untrusted;
it never authorizes input or causes automatic coordinate actions.

## Acceptance

A real Chromium closed-shadow fixture supports screenshot-mapped picker activation,
focused keyboard search/selection, chooser attachment and one approved final submit
using only service/SDK actions. Unit/contract tests cover strict action shapes,
DPR 1/2 receiver mapping and refusal of unqualified browser zoom, nonzero horizontal/vertical scroll,
scrollbar edges, pinch/offset refusal, foreign/expired/stale captures, same-URL reload
and same-origin navigation, document/authority races,
unsupported engines, approval-parameter changes, file replacement after approval,
competing choosers, timeout followed by a late chooser, and close during mousedown. Receiver counts prove refused
and uncertain operations are not replayed; method/host/rate/budget denials remain
ledgered. Live Bugcrowd verification remains pending operator verification.

References: [CDP mouse coordinates](https://chromedevtools.github.io/devtools-protocol/tot/Input/),
[CDP viewport metrics](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
[Playwright mouse CSS coordinates](https://playwright.dev/docs/api/class-mouse).
