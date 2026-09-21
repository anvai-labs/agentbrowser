# T4 Q0a: trusted application callback contracts

Status: implementation in progress from develop `e69317a`, after released 1.9.1.
This bounded repair precedes new mappings, production parity and security adapters.
It hardens trusted deployment configuration; it is not evidence of a stock remote
exploit or completion of T4.

## Existing ownership and minimum change

`ApplicationAuthority` remains the binding, dispatch and receipt owner. Reuse
`trusted-callback.synchronousResult` to reject asynchronous policy results and consume
their rejection; require literal `true`. Map callback exceptions and malformed results
to generic `CONTROL_REQUIRED` denial without callback messages or private data.
Keep authorization synchronous: waiting for a policy promise would create a new
admission/lifetime contract and is outside this slice.

Apply one guard to binding, discovery, execution and prepared receipt authorization.
Preserve the existing prepared-reader revocation latch, admission/drain and post-read
checks. Validate authorization before preparation as well as before dispatch. Reject
asynchronous or non-callable preparation results before marking dispatch. Capture
binding request/principal scalar values and original control identity/epoch before a
callback; reject replacement, takeover, reentrant binding or new busy state before
installing a binding. A callback cannot transfer an old tenant's binding to a new
registration of the same textual session ID.

At registration, snapshot each operation's name, read/write mode and bound prepare
function. Validate descriptors and their count with the existing protocol discovery
schema's operations contract, exposed through one protocol validator. Freeze owned
descriptors; preserve class method receivers and intentionally mutable adapter policy
state. Do not freeze caller objects or claim closure state is immutable. The typed
operation builder captures its parser/executor references so later method replacement
does not change an already declared operation. No executor, registry or schema copy
is introduced.

## Falsifying tests and acceptance

1. Promise-false, rejected Promise, thenable, truthy nonboolean and throwing callbacks
   cannot bind, discover, prepare/dispatch or read receipts. Rejections are consumed;
   diagnostics never echo synthetic private callback messages.
2. Same-ID session replacement, tenant changes, takeover, reentrant binding and busy
   state changes inside authorization cannot install an outer stale binding or reach
   preparation/dispatch. The replacement session remains unbound by the outer call.
3. Invalid operation names, modes, missing prepare functions and an oversized catalog
   fail registration. Mutation of caller-owned descriptors cannot downgrade a write,
   change discovery or replace registered preparation behavior.
4. Existing synchronous true/false callbacks, class receivers, explicit denial,
   versioned writes, exact-ID replay and receipt authority/drain semantics still pass.
5. Exercise the shared fix through existing HTTP tests and the application-only
   dependency-independence check. No browser/model/scanner dependency is introduced.

Run red tests first, focused control/protocol/API checks after repair, then existing
local and CI gates. Obtain independent adversarial review of the final head and merge
one bounded PR into develop. Keep 1.9.1 immutable; a later release checkpoint can
combine qualified follow-ups. Record remaining T4 production/parity and T6 widget gates
without advertising them as complete.
