# Mode: recurring business operations

Status: execution primitives exist; reusable durable workflows are proposed. Core applies.

## Job and data

Run one authorized recurring business process using a versioned mapping, private
value references, business scope, checkpoints and an explicit outcome predicate.
Choose one customer vertical before accumulating arbitrary site-specific recipes.
Keep user/account data outside source control and general harness memory.

## Shared execution

Reuse the common run lifecycle and action/application ports. Native forms use the
existing bulk executor. A mapping is data, not a new workflow service. Prefer a trusted
application operation when the requested job permits it, but never fallback after an
uncertain browser/API write. Reusing a mapping requires fresh scope and drift checks.

## Required outcome

Distinguish fields filled, save attempted and business record committed. Report the
applied prefix, unknown effects and cleanup. Resume only an undispatched suffix after
fresh authorization and reconciliation. Compensation is separately admitted and verified.
Scheduling waits for durable recovery; a cron trigger cannot make ephemeral state durable.

## Acceptance and footprint

Qualify account switches, repeated sections, expired mappings, duplicate submissions,
after-commit disconnects and service restart. The same core tests apply without copied
mode suites. Load only the active mapping and private references; no complete personal
history, browser trace or scanner runtime. Measure repair effort per recurring workflow.

Primary packets: T2/T4/T5; T6 only for concretely blocked widgets.
