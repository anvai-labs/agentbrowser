# T6 W2: exact chip sets with removal (evidence)

**Date:** 2026-10-15. **Packet:** [T6](../tasks/t6-widget-strategies.md).

`chip-multiselect` accepts
`options: { values, mode: 'exact' }`.

- **Engine evidence.** Each React Select chip remove control carries `autofill-chip-owner`
  (its combobox's node token) and `autofill-chip-label`. The value container reports
  `autofill-multi`.
- **Preconditions.** Exact mode refuses before any dispatch unless the control is a proven
  multi-value widget with complete, duplicate-free membership, and each extra chip has exactly one
  remove control tied to this combobox.
- **Writing the set.** Extra chips are removed one at a time, each removal confirmed by
  membership. Missing values are then added through the shared typeahead.
- **Verification.** Exact set equality, order-insensitive.
- **Partial effects.** The receipt records `effects: { removed, added }` in order, including on
  failure. There is no compensation, so a part-way failure is reported, not rolled back by
  guesswork: this widget has no reliable rollback.
- **Real-library qualification.** react-select 5.10.2 is the oracle, and the app's state matches
  every step:
  - empty → two, both added;
  - two → one, one removal;
  - already exact, no effects;
  - one → empty;
  - a part-way failure on an unknown option reports exactly the removal and addition that
    happened;
  - a single-select is refused before dispatch.

Still open: conditional and multi-stage mappings, and cross-engine qualification (W3).
