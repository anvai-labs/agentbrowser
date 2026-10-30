import { expect, it } from 'vitest';
import { type SummaryInfo, selectDisclosureRows } from './disclosure-rows.js';

it('caps rendered summaries at 200 while ignoring hidden nested rows', () => {
  const found: SummaryInfo[] = Array.from({ length: 210 }, (_, i) => [
    {
      index: i * 2,
      name: `Outer ${i}`,
      expanded: false,
      visible: true,
      explicitRole: false,
      hasPopup: false,
    },
    {
      index: i * 2 + 1,
      name: `Inner ${i}`,
      expanded: false,
      visible: false,
      explicitRole: false,
      hasPopup: false,
    },
  ]).flat();
  const selected = selectDisclosureRows(found, false);
  expect(selected.rows).toHaveLength(200);
  expect(selected.rows.at(-1)?.name).toBe('Outer 199');
  expect(selected.capReason).toBe('disclosure rows capped at 200 of 210');
});

it('excludes explicit roles and avoids duplicating form-control popup rows', () => {
  const row = {
    index: 0,
    name: 'Menu',
    expanded: false,
    visible: true,
    explicitRole: false,
    hasPopup: true,
  };
  expect(selectDisclosureRows([row], true).rows).toEqual([]);
  expect(selectDisclosureRows([row], false).rows).toEqual([row]);
  expect(selectDisclosureRows([{ ...row, explicitRole: true }], false).rows).toEqual([]);
});
