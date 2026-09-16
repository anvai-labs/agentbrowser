import {
  type AutofillMatch,
  type AutofillReceipt,
  type AutofillReport,
  type AutofillRequest,
  type PageElement,
  labelPattern,
  parseAutofillRequest,
} from '@agentbrowser/protocol';
import type { ServiceActRequest } from './service.js';

export interface AutofillPorts {
  assert(): void;
  redact?(value: string): string;
  resolveValue?(value: string): Promise<string>;
  observe(): Promise<{ elements: PageElement[]; truncated?: boolean; degraded?: boolean }>;
  act(request: ServiceActRequest): Promise<unknown>;
  snapshot(): Promise<{ artifactId: string }>;
}

interface WidgetStrategy {
  name: 'native-input' | 'native-select';
  supports(element: PageElement, field: AutofillRequest['fields'][number]): boolean;
  action(field: AutofillRequest['fields'][number], ref: string): ServiceActRequest;
}

// Trusted code owns the registry. No page-provided scripts or unqualified keyboard fallback.
const strategies: readonly WidgetStrategy[] = [
  {
    name: 'native-input',
    supports: (e, f) =>
      f.value !== undefined &&
      (e.attributes?.tag === 'textarea' ||
        (e.attributes?.tag === 'input' &&
          ['text', 'email', 'tel', 'url', 'search', 'number'].includes(
            e.attributes?.type ?? ''
          ))) &&
      !e.attributes?.['aria-autocomplete'] &&
      e.role !== 'combobox',
    action: (f, ref) => ({ action: 'fill', target: { ref }, value: f.value, remap: false }),
  },
  {
    name: 'native-select',
    supports: (e, f) =>
      f.option !== undefined && e.attributes?.tag === 'select' && e.attributes?.multiple !== 'true',
    action: (f, ref) => ({
      action: 'select',
      target: { ref },
      values: [f.option?.value ?? ''],
      remap: false,
    }),
  },
];

class AutofillFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function resolve(
  elements: PageElement[],
  match: AutofillMatch,
  blocks: Map<string, string>
): PageElement {
  let scoped = elements;
  if (match.block) {
    const block = match.block;
    scoped = elements.filter(
      (e) =>
        (block.id === undefined || e.attributes?.['fieldset-id'] === block.id) &&
        (block.label === undefined || e.attributes?.['fieldset-label'] === block.label)
    );
    const tokens = new Set(scoped.map((e) => e.attributes?.['autofill-block']).filter(Boolean));
    if (tokens.size !== 1)
      throw new AutofillFailure(
        tokens.size ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
        'Block must identify exactly one observed fieldset'
      );
    const token = [...tokens][0] as string;
    const key = JSON.stringify([block.id, block.label]);
    const pinned = blocks.get(key);
    if (pinned !== undefined && pinned !== token)
      throw new AutofillFailure('STALE_TARGET', 'Selected block was replaced');
    blocks.set(key, token);
  }
  const pattern = match.labelRegex === undefined ? undefined : labelPattern(match.labelRegex);
  const candidates = scoped.filter(
    (e) =>
      (match.role === undefined || match.role === e.role) &&
      (match.label === undefined || match.label === e.name) &&
      (pattern === undefined || pattern(e.name ?? '')) &&
      (match.dataAutomationId === undefined ||
        match.dataAutomationId === e.attributes?.['data-automation-id'])
  );
  if (candidates.length !== 1)
    throw new AutofillFailure(
      candidates.length ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
      'Field must identify exactly one observed control'
    );
  return candidates[0] as PageElement;
}

/** One serial admission. Retry means repeat reads, never repeat a dispatched write. */
export async function runAutofill(input: unknown, ports: AutofillPorts): Promise<AutofillReport> {
  const request = parseAutofillRequest(input);
  const policy = {
    onAmbiguous: 'fail',
    onVerifyFail: 'fail',
    maxReobserve: 3,
    settleMs: 250,
    timeoutMs: 240000,
    ...request.policy,
  };
  const started = performance.now();
  // Resolve the complete payload before browser I/O; dispatch retains the original
  // reference so the existing action layer still performs its normal secret handling.
  const expectedValues: string[] = [];
  for (const field of request.fields) {
    const value =
      field.value !== undefined
        ? await (ports.resolveValue?.(field.value) ?? field.value)
        : (field.option?.value ?? '');
    if (value.length > 8192) throw new Error('Resolved autofill value exceeds 8192 characters');
    expectedValues.push(value);
  }
  const blocks = new Map<string, string>();
  const identities = new Map<number, string>();
  const display = (receipt: AutofillReceipt, value: string | undefined) => {
    const redacted = value === undefined ? undefined : (ports.redact?.(value) ?? value);
    receipt.actual = redacted?.slice(0, 512);
    receipt.actualTruncated = redacted !== undefined && redacted.length > 512;
  };
  const receipts: AutofillReceipt[] = request.fields.map((f, field) => ({
    field,
    match: f.match,
    status: 'not_attempted',
    verified: false,
  }));
  const guard = () => {
    ports.assert();
    if (performance.now() - started >= policy.timeoutMs)
      throw new AutofillFailure(
        'ACTION_TIMEOUT',
        'Autofill deadline reached; remaining fields were not attempted'
      );
  };
  const observe = async () => {
    guard();
    const view = await ports.observe();
    guard();
    if (view.truncated || view.degraded)
      throw new AutofillFailure(
        'OUTPUT_TRUNCATED',
        'Autofill requires complete, non-degraded observations'
      );
    return view.elements;
  };
  for (const [index, field] of request.fields.entries()) {
    const receipt = receipts[index] as AutofillReceipt;
    let dispatched = false;
    try {
      let elements = await observe();
      let element: PageElement | undefined;
      // Revealed fields may arrive asynchronously; absence permits bounded read-only reobservation.
      for (let attempt = 0; ; attempt++) {
        try {
          element = resolve(elements, field.match, blocks);
          break;
        } catch (error) {
          if (
            !(error instanceof AutofillFailure) ||
            error.code !== 'TARGET_NOT_FOUND' ||
            attempt >= policy.maxReobserve
          )
            throw error;
          await new Promise((r) => setTimeout(r, policy.settleMs));
          elements = await observe();
        }
      }
      receipt.resolvedRef = element.ref;
      const identity = element.attributes?.['autofill-node'];
      const blockIdentity = element.attributes?.['autofill-block'];
      if (blockIdentity !== undefined) receipt.blockIdentity = blockIdentity;
      if (!element.visible || !element.enabled) {
        receipt.status = 'skipped';
        receipt.error = {
          code: 'TARGET_NOT_VISIBLE',
          message: 'Hidden or disabled control skipped; no write dispatched',
        };
        continue;
      }
      const strategy = strategies.find(
        (s) =>
          (field.strategy === undefined || field.strategy === s.name) && s.supports(element, field)
      );
      if (!identity || !strategy)
        throw new AutofillFailure(
          'ENGINE_UNSUPPORTED',
          'No qualified widget strategy or node identity evidence; no write dispatched'
        );
      identities.set(index, identity);
      guard();
      dispatched = true;
      const effect = await ports.act(strategy.action(field, element.ref));
      if (
        effect &&
        typeof effect === 'object' &&
        'actionId' in effect &&
        typeof effect.actionId === 'string'
      )
        receipt.actionId = effect.actionId;
      guard();
      if (field.verify === 'none') {
        receipt.status = 'unverified';
        continue;
      }
      const expected = expectedValues[index];
      for (let attempt = 0; ; attempt++) {
        await new Promise((r) => setTimeout(r, policy.settleMs));
        const fresh = await observe();
        const same = fresh.find((e) => e.attributes?.['autofill-node'] === identity);
        if (!same || same.attributes?.['autofill-block'] !== blockIdentity)
          throw new AutofillFailure(
            'STALE_TARGET',
            'Written control was replaced or moved; verification is uncertain'
          );
        // Verify the originally written node and selector, never a matching replacement.
        if (resolve(fresh, field.match, blocks).attributes?.['autofill-node'] !== identity)
          throw new AutofillFailure('STALE_TARGET', 'Field identity changed after dispatch');
        display(receipt, same.value);
        if (same.value === expected) {
          receipt.verified = true;
          receipt.status = 'verified';
          break;
        }
        if (policy.onVerifyFail !== 'retry' || attempt >= policy.maxReobserve) {
          receipt.status = 'failed';
          receipt.error = {
            code: 'VALUE_MISMATCH',
            message: 'Value did not match after settling; the write was not replayed',
          };
          break;
        }
      }
      if (!receipt.verified && policy.onVerifyFail !== 'skip') break;
    } catch (error) {
      // Authority loss must escape to the enclosing operation/output guard.
      ports.assert();
      receipt.status = dispatched ? 'uncertain' : 'failed';
      receipt.error =
        error instanceof AutofillFailure
          ? { code: error.code, message: error.message }
          : {
              code: 'ACTION_FAILED',
              message: 'Operation failed; inspect current state before another write',
            };
      if (
        !dispatched &&
        receipt.error.code === 'TARGET_AMBIGUOUS' &&
        policy.onAmbiguous === 'skip'
      ) {
        receipt.status = 'skipped';
        continue;
      }
      break;
    }
  }
  // Later input/change handlers can invalidate an earlier successful field.
  if (receipts.some((r) => r.verified)) {
    try {
      const final = await observe();
      for (const receipt of receipts.filter((r) => r.verified)) {
        const field = request.fields[receipt.field] as AutofillRequest['fields'][number];
        try {
          const same = resolve(final, field.match, blocks);
          if (
            same.attributes?.['autofill-node'] !== identities.get(receipt.field) ||
            same.attributes?.['autofill-block'] !== receipt.blockIdentity
          )
            throw new AutofillFailure(
              'STALE_TARGET',
              'Written control changed before final verification'
            );
          display(receipt, same.value);
          if (same.value !== expectedValues[receipt.field]) {
            receipt.verified = false;
            receipt.status = 'failed';
            receipt.error = {
              code: 'VALUE_MISMATCH',
              message: 'A later field changed this value before final verification',
            };
          }
        } catch {
          receipt.verified = false;
          receipt.status = 'uncertain';
          receipt.error = {
            code: 'STALE_TARGET',
            message: 'Final field identity could not be verified',
          };
        }
      }
    } catch {
      ports.assert();
      for (const receipt of receipts.filter((r) => r.verified)) {
        receipt.verified = false;
        receipt.status = 'uncertain';
        receipt.error = {
          code: 'VERIFICATION_UNAVAILABLE',
          message: 'Final verification unavailable or deadline reached',
        };
      }
    }
  }
  ports.assert();
  const report: AutofillReport = {
    ok: receipts.every((r) => r.status === 'verified' || r.status === 'unverified'),
    receipts,
    elapsedMs: performance.now() - started,
  };
  try {
    guard();
    const artifact = await ports.snapshot();
    report.snapshot = { ...artifact };
  } catch {
    ports.assert();
    report.snapshotError = 'Final HTML capture failed or deadline reached; inspect field receipts';
  }
  ports.assert();
  report.elapsedMs = performance.now() - started;
  return report;
}
