import type { PageElement } from '@agentbrowser/protocol';
import { parseAutofillReport } from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import { runAutofill } from './autofill.js';
import { browserReportOutcomeUnknown } from './service.js';

const navigationObservation = {
  status: 'blocked',
  reason: 'egress_policy',
  scope: 'SCOPE_HOST_DENIED',
  observedDuring: 'action',
} as const;
const textbox = (ref: string, name = ref, value = ''): PageElement => ({
  ref,
  role: 'textbox',
  name,
  value,
  visible: true,
  enabled: true,
  attributes: { tag: 'input', type: 'text', 'autofill-node': ref, 'autofill-block': '' },
});
const widget = (): PageElement => ({
  ...textbox('widget'),
  role: 'combobox',
  attributes: {
    ...textbox('widget').attributes,
    'aria-autocomplete': 'list',
    'autofill-focused': 'true',
    'autofill-popup': 'popup',
    'autofill-popup-state': 'ready',
  },
});
const option: PageElement = {
  ref: 'option',
  role: 'option',
  name: 'Choice',
  visible: true,
  enabled: true,
  attributes: {
    'autofill-owner': 'widget',
    'autofill-owner-focused': 'true',
    'autofill-popup': 'popup',
    'autofill-popup-state': 'ready',
  },
};
function fixture(initial: PageElement[], stopAt = 1, observation: unknown = navigationObservation) {
  let elements = initial;
  let calls = 0;
  const act = vi.fn(
    async (request: { target?: { ref?: string }; value?: string }, onDispatch: () => void) => {
      onDispatch();
      calls++;
      elements = elements.map((element) =>
        element.ref === request.target?.ref && request.value !== undefined
          ? { ...element, value: request.value }
          : element
      );
      return {
        status: 'success',
        actionId: `action-${calls}`,
        ...(calls === stopAt ? { navigationObservation: observation } : {}),
      };
    }
  );
  const observe = vi.fn(async () => ({ elements }));
  return {
    act,
    observe,
    assert: () => {},
    snapshot: vi.fn(async () => ({ artifactId: 'html' })),
    replace: (next: PageElement[]) => {
      elements = next;
    },
    current: () => elements,
  };
}
const fields = [
  { match: { label: 'first' }, value: 'one' },
  { match: { label: 'second' }, value: 'two' },
];

describe('autofill observed navigation stops', () => {
  it('does not skip a refusal that carries navigation evidence before a reported dispatch', async () => {
    const f = fixture([textbox('first'), textbox('second')]);
    f.act.mockImplementation(async () => {
      throw Object.assign(new Error('private adapter text'), {
        code: 'TARGET_AMBIGUOUS',
        details: { navigationObservation },
      });
    });
    const report = await runAutofill({ fields, policy: { onAmbiguous: 'skip' } }, f);
    expect(report.receipts.map((receipt) => receipt.status)).toEqual(['failed', 'not_attempted']);
    expect(report.receipts[0]?.navigationObservation).toEqual(navigationObservation);
    expect(f.act).toHaveBeenCalledOnce();
  });

  it('stops a native select without claiming its value was verified', async () => {
    const select: PageElement = {
      ...textbox('first'),
      role: 'combobox',
      attributes: { ...textbox('first').attributes, tag: 'select' },
    };
    const f = fixture([select, textbox('second')]);
    const report = await runAutofill(
      {
        fields: [
          { match: { label: 'first' }, option: { value: 'Choice' }, strategy: 'native-select' },
          fields[1],
        ],
        policy: { settleMs: 0 },
      },
      f
    );
    expect(report.receipts.map((receipt) => receipt.status)).toEqual([
      'uncertain',
      'not_attempted',
    ]);
    expect(f.act).toHaveBeenCalledOnce();
  });

  it('retains only confirmed chip removals and never dispatches the remaining removals', async () => {
    let members = ['A', 'B', 'C'];
    const elements = (): PageElement[] => [
      {
        ...widget(),
        attributes: {
          ...widget().attributes,
          'autofill-multi': 'true',
          'autofill-committed-members-complete': 'true',
          'autofill-committed-members': JSON.stringify(members),
        },
      },
      ...members.map((label) => ({
        ref: `remove-${label}`,
        role: 'button',
        name: `Remove ${label}`,
        visible: true,
        enabled: true,
        attributes: { 'autofill-chip-owner': 'widget', 'autofill-chip-label': label },
      })),
      textbox('second'),
    ];
    const f = fixture(elements(), 2);
    const originalAct = f.act.getMockImplementation();
    if (!originalAct) throw new Error('Missing fixture action');
    f.act.mockImplementation(async (...args) => {
      const effect = await originalAct(...args);
      const removed = args[0].target?.ref?.replace('remove-', '');
      members = members.filter((member) => member !== removed);
      f.replace(elements());
      return effect;
    });
    const report = await runAutofill(
      {
        fields: [
          {
            match: { label: 'widget' },
            strategy: 'chip-multiselect',
            options: { values: [], mode: 'exact' },
          },
          fields[1],
        ],
        policy: { settleMs: 0, onVerifyFail: 'skip' },
      },
      f
    );
    expect(report.receipts[0]).toMatchObject({
      status: 'uncertain',
      verified: false,
      actionId: 'action-2',
      navigationObservation,
      effects: { removed: ['A'], added: [] },
    });
    expect(report.receipts[1]?.status).toBe('not_attempted');
    expect(members).toEqual(['C']);
    expect(f.act).toHaveBeenCalledTimes(2);
  });
  it.each(['fail', 'skip', 'retry'] as const)(
    'stops native exact writes under %s policy without verification or replay',
    async (onVerifyFail) => {
      const f = fixture([textbox('first'), textbox('second')]);
      const report = await runAutofill({ fields, policy: { onVerifyFail, settleMs: 0 } }, f);
      expect(report.ok).toBe(false);
      expect(report.receipts.map((receipt) => receipt.status)).toEqual([
        'uncertain',
        'not_attempted',
      ]);
      expect(report.receipts[0]).toMatchObject({
        actionId: 'action-1',
        navigationObservation,
        verified: false,
        error: { code: 'AUTOFILL_NAVIGATION_BLOCKED' },
      });
      expect(browserReportOutcomeUnknown(report)).toBe(true);
      expect(f.act).toHaveBeenCalledOnce();
      expect(f.observe).toHaveBeenCalledOnce();
      expect(parseAutofillReport(report, 2)).toEqual(report);
    }
  );

  it('keeps a completed native verify:none effect unverified but stops the whole run', async () => {
    const f = fixture([textbox('first'), textbox('second')]);
    const report = await runAutofill(
      {
        fields: fields.map((field) => ({ ...field, verify: 'none' })),
        policy: { onVerifyFail: 'skip' },
      },
      f
    );
    expect(report).toMatchObject({
      ok: false,
      receipts: [
        { status: 'unverified', verified: false, actionId: 'action-1', navigationObservation },
        { status: 'not_attempted' },
      ],
    });
    expect(browserReportOutcomeUnknown(report)).toBe(false);
    expect(f.act).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3])(
    'stops the custom widget after dispatch %s even with verify:none',
    async (stopAt) => {
      const f = fixture([widget(), option, textbox('second')], stopAt);
      const report = await runAutofill(
        {
          fields: [
            {
              match: { label: 'widget' },
              strategy: 'react-select',
              option: { value: 'Choice' },
              verify: 'none',
            },
            fields[1],
          ],
          policy: { settleMs: 0, onVerifyFail: 'skip' },
        },
        f
      );
      expect(report.receipts[0]).toMatchObject({
        status: 'uncertain',
        verified: false,
        navigationObservation,
        actionId: `action-${stopAt}`,
      });
      expect(report.receipts[1]?.status).toBe('not_attempted');
      expect(f.act).toHaveBeenCalledTimes(stopAt);
    }
  );

  it.each([false, true])(
    'revalidates the verified prefix without further writes (unavailable=%s)',
    async (unavailable) => {
      const f = fixture([textbox('first'), textbox('second'), textbox('third')], 2);
      const originalObserve = f.observe.getMockImplementation();
      if (!originalObserve) throw new Error('Missing fixture observation');
      f.observe.mockImplementation(async () => {
        if (unavailable && f.act.mock.calls.length === 2) throw new Error('read failed');
        return originalObserve();
      });
      const report = await runAutofill(
        {
          fields: [...fields, { match: { label: 'third' }, value: 'three' }],
          policy: { settleMs: 0 },
        },
        f
      );
      expect(report.receipts.map((receipt) => receipt.status)).toEqual([
        unavailable ? 'uncertain' : 'verified',
        'uncertain',
        'not_attempted',
      ]);
      expect(report.receipts[1]).toMatchObject({ actionId: 'action-2', navigationObservation });
      expect(f.act).toHaveBeenCalledTimes(2);
    }
  );

  it('retains the observation before a deadline guard can mask it', async () => {
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const f = fixture([textbox('first'), textbox('second')]);
    const originalAct = f.act.getMockImplementation();
    if (!originalAct) throw new Error('Missing fixture action');
    f.act.mockImplementation(async (...args) => {
      const effect = await originalAct(...args);
      clock = 2000;
      return effect;
    });
    try {
      const report = await runAutofill({ fields, policy: { timeoutMs: 1000, settleMs: 0 } }, f);
      expect(report.receipts[0]).toMatchObject({
        status: 'uncertain',
        actionId: 'action-1',
        navigationObservation,
        error: { code: 'AUTOFILL_NAVIGATION_BLOCKED' },
      });
      expect(f.act).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  });

  it('preserves post-effect error evidence without converting a failed action to success', async () => {
    const f = fixture([textbox('first'), textbox('second')]);
    f.act.mockImplementation(async (_request, onDispatch) => {
      onDispatch();
      throw Object.assign(new Error('private adapter text'), {
        code: 'ENGINE_UNSUPPORTED',
        details: { actionId: 'action-1', navigationObservation, secret: 'private details' },
      });
    });
    const report = await runAutofill(
      { fields: fields.map((field) => ({ ...field, verify: 'none' })) },
      f
    );
    expect(report.receipts[0]).toMatchObject({
      status: 'uncertain',
      actionId: 'action-1',
      navigationObservation,
      error: { code: 'ENGINE_UNSUPPORTED' },
    });
    expect(JSON.stringify(report)).not.toContain('private');
    expect(f.act).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { ...navigationObservation, scope: 'SCOPE_HOST_DENIED private' },
    { ...navigationObservation, observedDuring: 'before_action' },
  ])('ignores malformed observations (%j)', async (observation) => {
    const f = fixture([textbox('first'), textbox('second')], 1, observation);
    const report = await runAutofill({ fields, policy: { settleMs: 0 } }, f);
    expect(report.ok).toBe(true);
    expect(report.receipts[0]).not.toHaveProperty('navigationObservation');
    expect(f.act).toHaveBeenCalledTimes(2);
  });

  it('projects only bounded navigation fields from a valid observation', async () => {
    const f = fixture([textbox('first'), textbox('second')], 1, {
      ...navigationObservation,
      url: 'https://private.invalid/token',
      message: 'private',
    });
    const report = await runAutofill({ fields, policy: { settleMs: 0 } }, f);
    expect(report.receipts[0]?.navigationObservation).toEqual(navigationObservation);
    expect(JSON.stringify(report)).not.toContain('private');
  });
});
