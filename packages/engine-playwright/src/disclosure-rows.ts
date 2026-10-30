import { MAX_FORM_CONTROLS_PER_ROOT } from '@agentbrowser/protocol';

/** One details' first summary, as the disclosure scan reports it. */
export interface SummaryInfo {
  /** Position within the SUMMARY_SELECTOR match list (document order). */
  index: number;
  name: string;
  expanded: boolean;
  visible: boolean;
  /** A valid explicit ARIA role: the snapshot already reports it under that role. */
  explicitRole: boolean;
  hasPopup: boolean;
}

/** Apply the same rendered-row budget independently of browser scheduling. */
export function selectDisclosureRows(
  found: SummaryInfo[],
  formControlsRequested: boolean
): {
  rows: SummaryInfo[];
  capReason?: string;
} {
  const eligible = found.filter(
    (info) => info.visible && !info.explicitRole && !(formControlsRequested && info.hasPopup)
  );
  return {
    rows: eligible.slice(0, MAX_FORM_CONTROLS_PER_ROOT),
    ...(eligible.length > MAX_FORM_CONTROLS_PER_ROOT
      ? {
          capReason: `disclosure rows capped at ${MAX_FORM_CONTROLS_PER_ROOT} of ${eligible.length}`,
        }
      : {}),
  };
}
