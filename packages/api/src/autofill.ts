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
  act(request: ServiceActRequest, onDispatch: () => void): Promise<unknown>;
  snapshot(): Promise<{ artifactId: string }>;
}

interface StrategyScope {
  /** Dispatch one wire action; marks the field dispatched on invocation. */
  act(request: ServiceActRequest): Promise<unknown>;
  /** Fresh, complete observation (guarded, non-degraded). */
  observe(): Promise<PageElement[]>;
  /** Re-resolve the original selector and identity after a prior step changed refs. */
  resolve(elements: PageElement[], match: AutofillMatch, identity: string): PageElement;
  /** Bounded read-only readiness polling; undefined means pending, exceptions stop. */
  ready<T>(read: (elements: PageElement[]) => T | undefined): Promise<T>;
}

interface WidgetStrategy {
  name: 'native-input' | 'native-select' | 'react-select' | 'chip-multiselect';
  supports(element: PageElement, field: AutofillRequest['fields'][number]): boolean;
  action(field: AutofillRequest['fields'][number], ref: string): ServiceActRequest;
  /** Strategy-owned proof that the requested value reached committed widget state. */
  isCommitted(element: PageElement, expected: string): boolean;
  /**
   * Multi-step commit for widget classes whose selection cannot be expressed
   * as one wire action (react-select menus need open → filter → fresh option
   * ref → click). The scope bounds every step inside the field's serial
   * admission; `expected` is the committed state the final recheck confirms.
   */
  run?(
    field: AutofillRequest['fields'][number],
    ref: string,
    identity: string,
    scope: StrategyScope
  ): Promise<{ expected: string }>;
}

const nativeValueCommitted = (element: PageElement, expected: string) => element.value === expected;

const singleValueCommitted = (element: PageElement, expected: string) =>
  element.attributes?.['autofill-committed'] === expected;

const MAX_COMMITTED_MEMBERS = 32;
const MAX_COMMITTED_MEMBER_CHARS = 512;
const MAX_COMMITTED_MEMBERS_JSON_CHARS = 16_384;

function committedMember(element: PageElement, expected: string): boolean {
  if (element.attributes?.['autofill-committed-members-complete'] !== 'true') return false;
  const encoded = element.attributes['autofill-committed-members'];
  if (encoded === undefined || encoded.length > MAX_COMMITTED_MEMBERS_JSON_CHARS) return false;
  try {
    const members: unknown = JSON.parse(encoded);
    return (
      Array.isArray(members) &&
      members.length <= MAX_COMMITTED_MEMBERS &&
      members.every(
        (member) => typeof member === 'string' && member.length <= MAX_COMMITTED_MEMBER_CHARS
      ) &&
      members.includes(expected)
    );
  } catch {
    return false;
  }
}

/** Shared typeahead sequence; selection must belong to this control's observed popup. */
const runTypeahead: NonNullable<WidgetStrategy['run']> = async (field, ref, identity, scope) => {
  const label = (field.option?.value ?? '').trim();
  if (!label) throw new AutofillFailure('INVALID_REQUEST', 'Widget requires option.value');
  let popup: string | undefined;
  const control = (elements: PageElement[]) => {
    const fresh = scope.resolve(elements, field.match, identity);
    if (!fresh.visible || !fresh.enabled || fresh.attributes?.['autofill-focused'] !== 'true')
      throw new AutofillFailure('STALE_TARGET', 'Widget lost focus or readiness');
    const state = fresh.attributes['autofill-popup-state'];
    if (state !== 'ready' && state !== 'pending')
      throw new AutofillFailure('ENGINE_UNSUPPORTED', 'Widget popup ownership is unavailable');
    if (state === 'ready') {
      const observed = fresh.attributes['autofill-popup'];
      if (!observed)
        throw new AutofillFailure('ENGINE_UNSUPPORTED', 'Widget popup identity is unavailable');
      if (popup !== undefined && observed !== popup)
        throw new AutofillFailure('STALE_TARGET', 'Widget popup was replaced');
      popup = observed;
    }
    return fresh;
  };
  await scope.act({ action: 'click', target: { ref }, remap: false });
  const input = control(await scope.observe());
  await scope.act({
    action: 'typeText',
    target: { ref: input.ref },
    value: label,
    delay: 35,
    remap: false,
  });
  const option = await scope.ready((elements) => {
    const fresh = control(elements);
    if (fresh.attributes?.['autofill-popup-state'] !== 'ready') return undefined;
    const matches = elements.filter(
      (candidate) =>
        candidate.role === 'option' &&
        candidate.visible &&
        candidate.attributes?.['autofill-owner'] === identity &&
        candidate.attributes['autofill-popup'] === popup &&
        (candidate.name ?? '').trim() === label
    );
    if (matches.length > 1)
      throw new AutofillFailure('TARGET_AMBIGUOUS', 'Multiple exact options in the owned popup');
    const match = matches[0];
    if (!match || !match.enabled) return undefined;
    if (
      match.attributes?.['autofill-popup-state'] !== 'ready' ||
      match.attributes['autofill-owner-focused'] !== 'true'
    )
      throw new AutofillFailure('STALE_TARGET', 'Option ownership or focus changed');
    return match;
  });
  await scope.act({ action: 'click', target: { ref: option.ref }, remap: false });
  return { expected: label };
};

const hasPopupEvidence = (element: PageElement) =>
  ['ready', 'pending'].includes(element.attributes?.['autofill-popup-state'] ?? '');

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
    isCommitted: nativeValueCommitted,
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
    isCommitted: nativeValueCommitted,
  },
  {
    // React-Select single-select (combobox with typeahead filter). The commit
    // path requires real per-char keystrokes to populate the option list, then
    // a click on the exact filtered option. The commitment predicate supports
    // known React Select-style single-value markup; query text is never proof.
    name: 'react-select',
    supports: (e, f) =>
      f.option !== undefined &&
      e.role === 'combobox' &&
      !!e.attributes?.['aria-autocomplete'] &&
      e.attributes?.tag === 'input' &&
      hasPopupEvidence(e),
    action: (f, ref) => ({ action: 'click', target: { ref }, remap: false }),
    isCommitted: singleValueCommitted,
    run: runTypeahead,
  },
  {
    // Add-only React Select-style multi-value control. A click commits only
    // when a complete, bounded membership capture contains the requested label.
    name: 'chip-multiselect',
    supports: (e, f) =>
      f.option !== undefined &&
      e.role === 'combobox' &&
      !!e.attributes?.['aria-autocomplete'] &&
      hasPopupEvidence(e),
    action: (f, ref) => ({ action: 'click', target: { ref }, remap: false }),
    isCommitted: committedMember,
    run: runTypeahead,
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
  const selectedStrategies = new Map<number, WidgetStrategy>();
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
    const execution: { state: 'not_started' | 'dispatched' | 'completed' } = {
      state: 'not_started',
    };
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
      selectedStrategies.set(index, strategy);
      guard();
      let effect: unknown;
      if (strategy.run) {
        // Multi-step strategy: each step dispatches through the same admission;
        // the scope keeps the loop inside this field's serial grant.
        const scope: StrategyScope = {
          act: async (request) => {
            guard();
            const effect = await ports.act(request, () => {
              if (execution.state === 'not_started') execution.state = 'dispatched';
            });
            execution.state = 'dispatched';
            return effect;
          },
          observe: async () => {
            guard();
            return observe();
          },
          resolve: (elements, match, expectedIdentity) => {
            const fresh = resolve(elements, match, blocks);
            if (
              fresh.attributes?.['autofill-node'] !== expectedIdentity ||
              fresh.attributes?.['autofill-block'] !== blockIdentity
            )
              throw new AutofillFailure('STALE_TARGET', 'Widget changed between strategy steps');
            return fresh;
          },
          ready: async (read) => {
            for (let attempt = 0; ; attempt++) {
              const result = read(await observe());
              if (result !== undefined) return result;
              if (attempt >= policy.maxReobserve)
                throw new AutofillFailure(
                  'TARGET_NOT_FOUND',
                  'No ready exact option in the owned popup'
                );
              await new Promise((r) => setTimeout(r, policy.settleMs));
              guard();
            }
          },
        };
        const outcome = await strategy.run(field, element.ref, identity, scope);
        execution.state = 'completed';
        if (outcome.expected !== undefined) expectedValues[index] = outcome.expected;
      } else {
        const effect = await ports.act(strategy.action(field, element.ref), () => {
          if (execution.state === 'not_started') execution.state = 'dispatched';
        });
        if (execution.state === 'not_started')
          throw new AutofillFailure(
            'ENGINE_UNSUPPORTED',
            'Action adapter returned without reporting its dispatch boundary'
          );
        execution.state = 'completed';
      }
      guard();
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
      const expected = expectedValues[index] as string;
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
        if (strategy.isCommitted(same, expected)) {
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
      receipt.status = execution.state === 'not_started' ? 'failed' : 'uncertain';
      receipt.error =
        error instanceof AutofillFailure
          ? { code: error.code, message: error.message }
          : {
              code: 'ACTION_FAILED',
              message: 'Operation failed; inspect current state before another write',
            };
      if (
        execution.state === 'not_started' &&
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
          const strategy = selectedStrategies.get(receipt.field);
          if (!strategy?.isCommitted(same, expectedValues[receipt.field] as string)) {
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
