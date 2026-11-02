# T10 foundation: owner-bound publication

Seeded cookie values must remain private on ordinary observations, live/retained
events and error traces. Registering initial values before engine work protects
request recorders; global-only output redaction does not protect these channels.
This slice depends on the captured-generation registry from ADR-030 and adds no
wire option, network authority or credential-transfer path.

Capture the exact session/page owner, current publication grant and its private
generation redactor before awaits. Recheck that captured owner before another
read or publication. Teardown and textual identifier reuse cannot select another
owner's registry. Same-generation additions remain protected. Ordinary observe
retains its ref/history/projection flow; redact before projection predicates and
after generated projection echoes, then apply the existing output budget.

Preserve trusted DTO property names and schema literal/enum constants. Service
identifiers/references stay exact; a registry collision refuses publication.
Redact untrusted string values and dictionary keys;
element attributes and change payloads require this distinction. Validate the
detached structured result and fail closed on invalid or excessive input.
The full pre-pagination view is bounded to 64 MiB, one million JSON nodes and
depth 32; ordinary output byte/element budgets still apply after redaction.
Event metadata retains its declared envelope while its data dictionary is
untrusted. Live delivery and retained replay receive the same sanitized event.

Redaction construction, refresh and publication faults halt only the captured
scope, append a fixed `recording.failed` marker to its captured ledger, and
produce fixed `floor.secret.redaction` diagnostics. Neither exception text nor
raw fallback data is published. Preserve existing post-effect uncertainty and
durable-operation no-replay semantics.

Colocated tests cover ordinary names/attributes, projection/diff keys, metadata
constants, registry additions and tenant isolation, close/reuse/takeover races,
live/replayed events, redactor faults and sealed ledger verification. Artifact
contents and other successful-output channels remain a separate audit; this
change makes no whole-session privacy claim.
