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

## Review round 1 (2026-10-15)

- **Whitespace.** Chip labels are compared trimmed: membership capture and typeahead both trim.
  `options.values` must therefore be non-blank and carry no surrounding whitespace, and anything
  else is refused by the protocol before anything runs. Before this, `'Canada '` removed and
  re-added a chip and under-reported the add, and `' '` removed a chip before failing.
- **Every claimed guard is pinned by a unit test** that fails when the guard is mutated away:
  - the multi-value check in verification;
  - the remover visibility check;
  - confirmation after each removal and after each add (effects only after confirmation);
  - set size and member duplicates in verification;
  - redaction of effect labels.
- **OpenAPI.** `openapi.json` is regenerated for `options` and `effects`.
- **Sensitivity.** `autofill-chip-label` is published without classification, because it equals
  the remove control's accessible name, `Remove <label>`, which react-select 5.10.2 always sets.
  A site that overrides `MultiValueRemove` with a different name could expose a chip label that a
  sensitive combobox's withheld membership would hide. Recorded, not changed: chip text is
  normally visible page content.
- **Mapping.** `form-mapping` (`autofill-map`) still expresses only `value` and `option`, so exact
  sets are request-only for now. W3 covers mappings.

