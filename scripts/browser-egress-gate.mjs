/** Offline qualification evidence, not a runtime capability or a security attestation. */
export const REQUIRED_CHANNELS = Object.freeze([
  'navigation', 'redirect', 'frame', 'fetch', 'dedicated-worker', 'shared-worker', 'service-worker', 'popup', 'websocket',
]);
const boundaries = ['responseBytesBeforeDelivery', 'dnsConnectionBinding', 'startupBeforeExecution', 'forcedEgress'];
export function evaluateBrowserEgress(report, expected) {
  const reasons = [];
  if (!report || typeof report !== 'object') return { ready: false, reasons: ['missing-report'] };
  if (report.errors !== undefined && (!Array.isArray(report.errors) || report.errors.length)) reasons.push('probe-errors');
  for (const key of ['candidate', 'driver', 'browser']) {
    if (typeof expected?.[key] !== 'string' || !expected[key] || report[key] !== expected[key]) reasons.push(`${key}:mismatch`);
  }
  if (!Array.isArray(report.channels)) reasons.push('missing-channels');
  const rows = Array.isArray(report.channels) ? report.channels : [];
  for (const channel of REQUIRED_CHANNELS) {
    const matches = rows.filter(row => row?.channel === channel);
    if (matches.length !== 1) { reasons.push(`${channel}:missing-or-duplicate`); continue; }
    const row = matches[0];
    if (!['allowedHits', 'deniedHits', 'denialCallbacks'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)) {
      reasons.push(`${channel}:invalid-count`); continue;
    }
    if (row.allowedHits < 1 || row.allowedCompleted !== true) reasons.push(`${channel}:control-unproven`);
    if (row.deniedCompleted !== true || row.denialCallbacks < 1) reasons.push(`${channel}:denial-unproven`);
    if (row.deniedHits !== 0) reasons.push(`${channel}:destination-reached`);
  }
  for (const key of boundaries) {
    if (report.boundaries?.[key] !== 'verified') reasons.push(`${key}:${report.boundaries?.[key] ?? 'missing'}`);
  }
  return { ready: reasons.length === 0, reasons };
}
