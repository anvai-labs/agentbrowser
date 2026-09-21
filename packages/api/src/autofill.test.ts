import type { PageElement } from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import { runAutofill } from './autofill.js';

const field = (token: string, block: string, value = ''): PageElement => ({
  ref: token,
  role: 'textbox',
  name: 'Company name',
  value,
  visible: true,
  enabled: true,
  attributes: {
    tag: 'input',
    type: 'text',
    'autofill-node': token,
    'autofill-block': block,
    'fieldset-id': block,
    'fieldset-label': 'Employment',
  },
});

function fixture(initial: PageElement[]) {
  let elements = initial;
  const dispatch = vi.fn();
  const act = vi.fn(
    async (request: { target?: { ref?: string }; value?: string }, onDispatch: () => void) => {
      onDispatch();
      dispatch();
      elements = elements.map((e) =>
        e.ref === request.target?.ref ? { ...e, value: request.value } : e
      );
    }
  );
  const observe = vi.fn(async () => ({ elements }));
  return {
    act,
    dispatch,
    observe,
    assert: vi.fn(),
    snapshot: vi.fn(async () => ({ artifactId: 'html' })),
    replace: (next: PageElement[]) => {
      elements = next;
    },
  };
}

describe('bulk autofill closed loop', () => {
  it('fills identical labels within stable blocks despite document reorder', async () => {
    const f = fixture([field('a', 'old'), field('b', 'current')]);
    f.act.mockImplementationOnce(async (_request, onDispatch) => {
      onDispatch();
      f.dispatch();
      f.replace([field('b', 'current'), field('a', 'old', 'Past')]);
    });
    const report = await runAutofill(
      {
        fields: [
          { match: { label: 'Company name', block: { id: 'old' } }, value: 'Past' },
          { match: { label: 'Company name', block: { id: 'current' } }, value: 'Present' },
        ],
        policy: { settleMs: 0 },
      },
      f
    );
    expect(report.ok).toBe(true);
    expect(report.receipts.map((r) => [r.resolvedRef, r.verified])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(f.act).toHaveBeenCalledTimes(2);
    expect(f.snapshot).toHaveBeenCalledOnce();
  });

  it('fails ambiguous labels before writing and reports the unattempted suffix', async () => {
    const f = fixture([field('a', 'one'), field('b', 'two')]);
    const report = await runAutofill(
      {
        fields: [
          { match: { label: 'Company name' }, value: 'x' },
          { match: { label: 'Other' }, value: 'y' },
        ],
      },
      f
    );
    expect(report.receipts.map((r) => r.status)).toEqual(['failed', 'not_attempted']);
    expect(report.receipts[0]?.error?.code).toBe('TARGET_AMBIGUOUS');
    expect(f.act).not.toHaveBeenCalled();
  });

  it('retries verification reads without replaying a write', async () => {
    const f = fixture([field('a', 'one')]);
    f.act.mockImplementation(async (_request, onDispatch) => {
      onDispatch();
      f.dispatch();
    });
    const report = await runAutofill(
      {
        fields: [{ match: { label: 'Company name' }, value: 'x' }],
        policy: { onVerifyFail: 'retry', maxReobserve: 2, settleMs: 0 },
      },
      f
    );
    expect(report.receipts[0]).toMatchObject({ status: 'failed', verified: false, actual: '' });
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.observe).toHaveBeenCalledTimes(4);
  });

  it('does not accept an identical replacement node as verification evidence', async () => {
    const f = fixture([field('a', 'one')]);
    f.act.mockImplementation(async (_request, onDispatch) => {
      onDispatch();
      f.dispatch();
      f.replace([field('replacement', 'one', 'x')]);
    });
    const report = await runAutofill(
      { fields: [{ match: { label: 'Company name' }, value: 'x' }], policy: { settleMs: 0 } },
      f
    );
    expect(report.receipts[0]).toMatchObject({ status: 'uncertain', verified: false });
  });

  it('stops after an uncertain dispatch even with skip policy', async () => {
    const f = fixture([field('a', 'one')]);
    f.act.mockImplementation(async (_request, onDispatch) => {
      onDispatch();
      f.dispatch();
      throw new Error('transport closed after input handler');
    });
    const report = await runAutofill(
      {
        fields: [
          { match: { label: 'Company name' }, value: 'x' },
          { match: { label: 'Company name' }, value: 'y' },
        ],
        policy: { onVerifyFail: 'skip' },
      },
      f
    );
    expect(report.receipts.map((r) => r.status)).toEqual(['uncertain', 'not_attempted']);
    expect(f.act).toHaveBeenCalledOnce();
  });

  it('reports a refusal before the dispatch callback as failed', async () => {
    const f = fixture([field('a', 'one')]);
    f.act.mockRejectedValue(new Error('approval refused before engine dispatch'));
    const report = await runAutofill(
      {
        fields: [
          { match: { label: 'Company name' }, value: 'x' },
          { match: { label: 'Company name' }, value: 'y' },
        ],
      },
      f
    );
    expect(report.receipts.map((receipt) => receipt.status)).toEqual(['failed', 'not_attempted']);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.observe).toHaveBeenCalledOnce();
  });

  it('refuses partial observations instead of declaring a candidate unique', async () => {
    const f = fixture([field('a', 'one')]);
    const report = await runAutofill(
      { fields: [{ match: { label: 'Company name' }, value: 'x' }] },
      { ...f, observe: async () => ({ elements: [field('a', 'one')], truncated: true }) }
    );
    expect(report.receipts[0]?.error?.code).toBe('OUTPUT_TRUNCATED');
    expect(f.act).not.toHaveBeenCalled();
  });

  it('validates the entire payload before any I/O', async () => {
    const f = fixture([]);
    await expect(
      runAutofill(
        {
          fields: [
            { match: { label: 'Company name' }, value: 'x' },
            { match: { labelRegex: '(a+)+$' }, value: 'y' },
          ],
        },
        f
      )
    ).rejects.toThrow('labelRegex');
    expect(f.observe).not.toHaveBeenCalled();
  });
});

it('rechecks earlier fields after later handlers modify them', async () => {
  const f = fixture([field('a', 'old'), field('b', 'current')]);
  f.act
    .mockImplementationOnce(async (_request, onDispatch) => {
      onDispatch();
      f.dispatch();
      f.replace([field('a', 'old', 'A'), field('b', 'current')]);
    })
    .mockImplementationOnce(async (_request, onDispatch) => {
      onDispatch();
      f.dispatch();
      f.replace([field('a', 'old', 'reverted'), field('b', 'current', 'B')]);
    });
  const report = await runAutofill(
    {
      fields: [
        { match: { label: 'Company name', block: { id: 'old' } }, value: 'A' },
        { match: { label: 'Company name', block: { id: 'current' } }, value: 'B' },
      ],
      policy: { settleMs: 0 },
    },
    f
  );
  expect(report.ok).toBe(false);
  expect(report.receipts[0]).toMatchObject({ verified: false, actual: 'reverted' });
});

it('does no new I/O after the cooperative deadline while draining an in-flight write', async () => {
  const f = fixture([field('a', 'one')]);
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  f.act.mockImplementation(async (_request, onDispatch) => {
    onDispatch();
    f.dispatch();
    now = 200;
  });
  try {
    const report = await runAutofill(
      { fields: [{ match: { label: 'Company name' }, value: 'A' }], policy: { timeoutMs: 100 } },
      f
    );
    expect(report.receipts[0]?.status).toBe('uncertain');
    expect(f.observe).toHaveBeenCalledOnce();
    expect(f.snapshot).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it('bounds displayed actuals and compares the full private value before redaction', async () => {
  const f = fixture([field('a', 'one', 'secret'.repeat(1000))]);
  f.act.mockImplementation(async (_request, onDispatch) => {
    onDispatch();
    f.dispatch();
  });
  const report = await runAutofill(
    { fields: [{ match: { label: 'Company name' }, value: '***' }], policy: { settleMs: 0 } },
    { ...f, redact: (value) => value.replaceAll('secret', '***') }
  );
  expect(report.receipts[0]).toMatchObject({ verified: false, actualTruncated: true });
  expect(report.receipts[0]?.actual?.length).toBe(512);
});

describe('multi-step widget strategies', () => {
  const runStrategy = async (
    input: Parameters<typeof runAutofill>[0],
    ports: Parameters<typeof runAutofill>[1]
  ) => {
    vi.useFakeTimers();
    try {
      const pending = runAutofill(input, ports);
      await vi.runAllTimersAsync();
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  const rsCombobox = (ref: string, committed = '', block = 'rs-block'): PageElement => ({
    ref,
    role: 'combobox',
    name: 'Location (City)',
    value: '',
    visible: true,
    enabled: true,
    attributes: {
      tag: 'input',
      'aria-autocomplete': 'list',
      'autofill-node': ref,
      'autofill-block': block,
      'autofill-popup': `${ref}-popup`,
      'autofill-popup-state': 'ready',
      'autofill-focused': 'true',
      ...(committed ? { 'autofill-committed': committed } : {}),
    },
  });

  const chipCombobox = (ref: string, members: readonly string[], complete = true): PageElement => ({
    ...rsCombobox(ref),
    name: 'Country Phone Code',
    attributes: {
      ...rsCombobox(ref).attributes,
      'autofill-committed-members': JSON.stringify(members),
      'autofill-committed-members-complete': String(complete),
    },
  });

  it('react-select: verifies an empty native value from exact committed evidence', async () => {
    const f = fixture([rsCombobox('rs_1')]);
    let clicked = 0;
    const optionRef = 'opt_1';
    // act dispatch: click on the combobox ref opens the menu; typeText triggers
    // the filter; click on the option ref commits.
    f.act.mockImplementation(
      async (
        request: { action: string; target?: { ref?: string }; value?: string },
        onDispatch: () => void
      ) => {
        onDispatch();
        f.dispatch();
        if (request.action === 'typeText') {
          // after typing, the filtered option appears
          f.replace([
            rsCombobox('rs_1'),
            {
              ...rsCombobox('rs_1'),
              ref: optionRef,
              role: 'option',
              name: 'Chicago, Illinois, United States',
              value: undefined,
              attributes: {
                ...ownedOption('opt_1', '', 'rs_1').attributes,
                tag: 'li',
                'autofill-node': 'opt_1',
                'autofill-block': 'rs-block',
              },
            },
          ]);
        }
        if (request.action === 'click' && request.target?.ref === optionRef) {
          clicked++;
          // commit: chip text appears as autofill-committed
          f.replace([rsCombobox('rs_1', 'Chicago, Illinois, United States')]);
        }
        return { actionId: `a_${++clicked}` };
      }
    );
    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago, Illinois, United States' },
            strategy: 'react-select',
          },
        ],
      },
      { ...f, act: f.act }
    );
    expect(report.ok).toBe(true);
    expect(report.receipts[0].status).toBe('verified');
    expect(report.receipts[0].verified).toBe(true);
    expect(clicked).toBeGreaterThan(0);
  });

  it('react-select: query text alone never proves that the option committed', async () => {
    const f = fixture([rsCombobox('rs_query')]);
    const optionRef = 'opt_query_only';
    f.act.mockImplementation(
      async (
        request: { action: string; target?: { ref?: string }; value?: string },
        onDispatch: () => void
      ) => {
        onDispatch();
        f.dispatch();
        if (request.action === 'typeText') {
          f.replace([
            rsCombobox('rs_query'),
            {
              ...rsCombobox('rs_query'),
              ref: optionRef,
              role: 'option',
              name: 'Chicago',
              attributes: {
                ...ownedOption('', '', 'rs_query').attributes,
                tag: 'li',
                'autofill-node': optionRef,
                'autofill-block': 'rs-block',
              },
            },
          ]);
        }
        if (request.action === 'click' && request.target?.ref === optionRef) {
          f.replace([{ ...rsCombobox('rs_query'), value: 'Chicago' }]);
        }
      }
    );

    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
        ],
        policy: { settleMs: 0 },
      },
      { ...f, act: f.act }
    );

    expect(report.ok).toBe(false);
    expect(report.receipts[0]).toMatchObject({
      status: 'failed',
      verified: false,
      error: { code: 'VALUE_MISMATCH' },
    });
  });

  it('react-select: final verification catches a committed selection that was lost', async () => {
    const f = fixture([rsCombobox('rs_lost')]);
    const optionRef = 'opt_lost';
    let committed = false;
    let committedReads = 0;
    const observe = f.observe.getMockImplementation();
    if (!observe) throw new Error('fixture observe implementation missing');
    f.observe.mockImplementation(async () => {
      if (committed && ++committedReads === 2) f.replace([rsCombobox('rs_lost')]);
      return observe();
    });
    f.act.mockImplementation(
      async (request: { action: string; target?: { ref?: string } }, onDispatch: () => void) => {
        onDispatch();
        f.dispatch();
        if (request.action === 'typeText') {
          f.replace([
            rsCombobox('rs_lost'),
            {
              ...rsCombobox('rs_lost'),
              ref: optionRef,
              role: 'option',
              name: 'Chicago',
              attributes: {
                ...ownedOption('', '', 'rs_lost').attributes,
                tag: 'li',
                'autofill-node': optionRef,
                'autofill-block': 'rs-block',
              },
            },
          ]);
        }
        if (request.action === 'click' && request.target?.ref === optionRef) {
          committed = true;
          f.replace([rsCombobox('rs_lost', 'Chicago')]);
        }
      }
    );

    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
        ],
        policy: { settleMs: 0 },
      },
      { ...f, act: f.act }
    );

    expect(report.ok).toBe(false);
    expect(report.receipts[0]).toMatchObject({ status: 'failed', verified: false });
    expect(f.dispatch).toHaveBeenCalledTimes(3);
  });

  it('react-select: refuses an ambiguous control before typing through a refreshed ref', async () => {
    const f = fixture([rsCombobox('rs_original')]);
    f.act.mockImplementation(async (request: { action: string }, onDispatch: () => void) => {
      onDispatch();
      f.dispatch();
      if (request.action === 'click') {
        f.replace([rsCombobox('rs_original'), rsCombobox('rs_duplicate')]);
      }
    });

    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
        ],
      },
      { ...f, act: f.act }
    );

    expect(report.receipts[0]).toMatchObject({
      status: 'uncertain',
      verified: false,
      error: { code: 'TARGET_AMBIGUOUS' },
    });
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.act).toHaveBeenCalledOnce();
  });

  it('react-select: refuses a control moved after opening before typing', async () => {
    const f = fixture([rsCombobox('rs_moved')]);
    f.act.mockImplementation(async (request: { action: string }, onDispatch: () => void) => {
      onDispatch();
      f.dispatch();
      if (request.action === 'click') f.replace([rsCombobox('rs_moved', '', 'other-block')]);
    });

    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
          { match: { label: 'Company name' }, value: 'suffix' },
        ],
      },
      { ...f, act: f.act }
    );

    expect(report.receipts).toMatchObject([
      { status: 'uncertain', error: { code: 'STALE_TARGET' } },
      { status: 'not_attempted' },
    ]);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.act).toHaveBeenCalledOnce();
  });

  it('react-select: rechecks the control after typing before clicking an option', async () => {
    const f = fixture([rsCombobox('rs_moved_after_type')]);
    const optionRef = 'option_after_move';
    f.act.mockImplementation(async (request: { action: string }, onDispatch: () => void) => {
      onDispatch();
      f.dispatch();
      if (request.action === 'typeText') {
        f.replace([
          rsCombobox('rs_moved_after_type', '', 'other-block'),
          {
            ...rsCombobox('rs_moved_after_type'),
            ref: optionRef,
            role: 'option',
            name: 'Chicago',
            attributes: {
              ...ownedOption('', '', 'rs_moved_after_type').attributes,
              tag: 'li',
              'autofill-node': optionRef,
              'autofill-block': 'other-block',
            },
          },
        ]);
      }
    });

    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
          { match: { label: 'Company name' }, value: 'suffix' },
        ],
      },
      { ...f, act: f.act }
    );

    expect(report.receipts).toMatchObject([
      { status: 'uncertain', error: { code: 'STALE_TARGET' } },
      { status: 'not_attempted' },
    ]);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.act).toHaveBeenCalledTimes(2);
  });

  it('react-select: no matching option produces TARGET_NOT_FOUND without a selection click', async () => {
    const f = fixture([rsCombobox('rs_1')]);
    // click opens the menu but typing filters to nothing
    f.act.mockImplementation(async (request: { action: string }, onDispatch: () => void) => {
      onDispatch();
      f.dispatch();
      if (request.action === 'typeText') {
        f.replace([rsCombobox('rs_1')]); // no options appear
      }
    });
    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Nonexistent' },
            strategy: 'react-select',
          },
        ],
      },
      { ...f, act: f.act }
    );
    expect(report.ok).toBe(false);
    expect(report.receipts[0].status).toBe('uncertain');
    expect(report.receipts[0].error?.code).toBe('TARGET_NOT_FOUND');
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });

  it('chip-multiselect: click-open, typeText filter, click chip option, verified via chip', async () => {
    const f = fixture([chipCombobox('ms_1', [])]);
    const chipRef = 'chip_1';
    f.act.mockImplementation(
      async (
        request: { action: string; target?: { ref?: string }; value?: string },
        onDispatch: () => void
      ) => {
        onDispatch();
        f.dispatch();
        if (request.action === 'typeText') {
          f.replace([
            chipCombobox('ms_1', []),
            {
              ...rsCombobox('ms_1'),
              ref: chipRef,
              role: 'option',
              name: 'United States of America',
              value: undefined,
              attributes: {
                ...ownedOption('chip_1', '', 'ms_1').attributes,
                tag: 'li',
                'autofill-node': 'chip_1',
                'autofill-block': 'ms-block',
              },
            },
          ]);
        }
        if (request.action === 'click' && request.target?.ref === chipRef) {
          f.replace([chipCombobox('ms_1', ['United States of America'])]);
        }
      }
    );
    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Country Phone Code' },
            option: { value: 'United States of America' },
            strategy: 'chip-multiselect',
          },
        ],
      },
      { ...f, act: f.act }
    );
    expect(report.ok).toBe(true);
    expect(report.receipts[0].status).toBe('verified');
  });

  it('chip-multiselect: incomplete committed-membership evidence refuses verification', async () => {
    const f = fixture([chipCombobox('ms_incomplete', [])]);
    const chipRef = 'chip_incomplete';
    f.act.mockImplementation(
      async (request: { action: string; target?: { ref?: string } }, onDispatch: () => void) => {
        onDispatch();
        f.dispatch();
        if (request.action === 'typeText') {
          f.replace([
            chipCombobox('ms_incomplete', []),
            {
              ...rsCombobox('ms_incomplete'),
              ref: chipRef,
              role: 'option',
              name: 'United States of America',
              attributes: {
                ...ownedOption('', '', 'ms_incomplete').attributes,
                tag: 'li',
                'autofill-node': chipRef,
                'autofill-block': 'ms-block',
              },
            },
          ]);
        }
        if (request.action === 'click' && request.target?.ref === chipRef) {
          f.replace([chipCombobox('ms_incomplete', ['United States of America'], false)]);
        }
      }
    );

    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Country Phone Code' },
            option: { value: 'United States of America' },
            strategy: 'chip-multiselect',
          },
        ],
        policy: { settleMs: 0 },
      },
      { ...f, act: f.act }
    );

    expect(report.ok).toBe(false);
    expect(report.receipts[0]).toMatchObject({ status: 'failed', verified: false });
  });

  it('strategy refusal: react-select combobox without option.value produces INVALID_REQUEST', async () => {
    const f = fixture([]);
    f.act.mockImplementation(async (request: Record<string, unknown>, onDispatch: () => void) => {
      onDispatch();
      f.dispatch();
    });
    await expect(
      runAutofill(
        {
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              strategy: 'react-select',
            },
          ],
        },
        { ...f, act: f.act }
      )
    ).rejects.toThrow('exactly one of value or option.value');
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
  });
  const ownedOption = (ref = 'owned-option', name = 'Chicago', owner = 'owned'): PageElement => ({
    ref,
    role: 'option',
    name,
    visible: true,
    enabled: true,
    attributes: {
      'autofill-node': ref,
      'autofill-popup': `${owner}-popup`,
      'autofill-owner': owner,
      'autofill-owner-focused': 'true',
      'autofill-popup-state': 'ready',
    },
  });
  const ownedControl = (): PageElement => ({
    ...rsCombobox('owned'),
    attributes: {
      ...rsCombobox('owned').attributes,
      'autofill-popup': 'owned-popup',
      'autofill-popup-state': 'ready',
      'autofill-focused': 'true',
    },
  });

  for (const strategy of ['react-select', 'chip-multiselect'] as const) {
    it.each([
      'other-popup',
      'prefix',
      'case-only',
      'duplicate',
      'disabled',
      'focus-theft',
      'popup-replaced',
      'missing-evidence',
    ] as const)(
      `${strategy}: refuses %s without clicking an unsafe option or continuing the suffix`,
      async (fault) => {
        const f = fixture([ownedControl(), field('suffix', 'suffix')]);
        const choices =
          fault === 'duplicate'
            ? [ownedOption(), ownedOption('duplicate')]
            : fault === 'prefix'
              ? [ownedOption('prefix', 'Chicago Heights')]
              : fault === 'other-popup'
                ? [ownedOption('unrelated', 'Chicago', 'other')]
                : [ownedOption()];
        if (fault === 'case-only') choices[0] = ownedOption('lowercase', 'chicago');
        if (fault === 'disabled') choices[0] = { ...choices[0]!, enabled: false };
        f.act.mockImplementation(async (request: { action: string }, onDispatch) => {
          onDispatch();
          f.dispatch();
          if (request.action === 'typeText') {
            const control = ownedControl();
            if (fault === 'focus-theft') control.attributes!['autofill-focused'] = 'false';
            if (fault === 'popup-replaced') control.attributes!['autofill-popup'] = 'replacement';
            if (fault === 'missing-evidence')
              control.attributes = Object.fromEntries(
                Object.entries(control.attributes ?? {}).filter(
                  ([key]) => key !== 'autofill-popup-state'
                )
              );
            f.replace([control, ...choices, field('suffix', 'suffix')]);
          }
        });
        const report = await runStrategy(
          {
            fields: [
              {
                match: { role: 'combobox', label: 'Location (City)' },
                option: { value: 'Chicago' },
                strategy,
              },
              { match: { label: 'Company name' }, value: 'must not execute' },
            ],
            policy: { maxReobserve: 1, settleMs: 0, onAmbiguous: 'skip' },
          },
          f
        );
        expect(report.receipts).toMatchObject([
          { status: 'uncertain', verified: false },
          { status: 'not_attempted' },
        ]);
        expect(f.act.mock.calls.map(([request]) => request.target?.ref)).toEqual([
          'owned',
          'owned',
        ]);
      }
    );

    it.each(['ready', 'pending'] as const)(
      `${strategy}: waits from %s for owned options without replaying writes and ignores an identical foreign option`,
      async (initialState) => {
        const initial = ownedControl();
        initial.attributes = {
          ...initial.attributes,
          'autofill-popup-state': initialState,
          'autofill-popup': initialState === 'ready' ? 'owned-popup' : '',
        };
        const f = fixture([initial]);
        let typed = false;
        let selected = false;
        let reads = 0;
        const read = f.observe.getMockImplementation()!;
        f.observe.mockImplementation(async () => {
          if (typed && !selected && ++reads === 2)
            f.replace([ownedControl(), ownedOption('foreign', 'Chicago', 'other'), ownedOption()]);
          return read();
        });
        f.act.mockImplementation(
          async (request: { action: string; target?: { ref?: string } }, onDispatch) => {
            onDispatch();
            f.dispatch();
            if (request.action === 'typeText') typed = true;
            if (request.target?.ref === 'owned-option') {
              selected = true;
              const control = ownedControl();
              Object.assign(control.attributes!, {
                'autofill-committed': 'Chicago',
                'autofill-committed-members': '["Chicago"]',
                'autofill-committed-members-complete': 'true',
              });
              f.replace([control]);
            }
          }
        );
        const report = await runStrategy(
          {
            fields: [
              {
                match: { role: 'combobox', label: 'Location (City)' },
                option: { value: 'Chicago' },
                strategy,
              },
            ],
            policy: { maxReobserve: 2, settleMs: 0 },
          },
          f
        );
        expect(report.ok).toBe(true);
        expect(f.act.mock.calls.map(([request]) => request.target?.ref)).toEqual([
          'owned',
          'owned',
          'owned-option',
        ]);
        expect(reads).toBe(2);
      }
    );
  }
  it('refuses missing engine ownership evidence before any widget write', async () => {
    const control = ownedControl();
    control.attributes = { tag: 'input', 'aria-autocomplete': 'list', 'autofill-node': 'owned' };
    const f = fixture([control]);
    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
        ],
      },
      f
    );
    expect(report.receipts[0]).toMatchObject({
      status: 'failed',
      error: { code: 'ENGINE_UNSUPPORTED' },
    });
    expect(f.act).not.toHaveBeenCalled();
  });

  it('refuses focus theft immediately after opening before typing', async () => {
    const f = fixture([ownedControl()]);
    f.act.mockImplementation(async (_request, onDispatch) => {
      onDispatch();
      const control = ownedControl();
      control.attributes = { ...control.attributes, 'autofill-focused': 'false' };
      f.replace([control]);
    });
    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
        ],
      },
      f
    );
    expect(report.receipts[0]).toMatchObject({
      status: 'uncertain',
      error: { code: 'STALE_TARGET' },
    });
    expect(f.act).toHaveBeenCalledOnce();
  });
  it.each([0, 2])(
    'bounds option absence to %i extra reads without replaying writes',
    async (maxReobserve) => {
      const f = fixture([ownedControl()]);
      f.act.mockImplementation(async (_request, onDispatch) => {
        onDispatch();
      });
      const report = await runStrategy(
        {
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              option: { value: 'Chicago' },
              strategy: 'react-select',
            },
          ],
          policy: { maxReobserve, settleMs: 0 },
        },
        f
      );
      expect(report.receipts[0]).toMatchObject({
        status: 'uncertain',
        error: { code: 'TARGET_NOT_FOUND' },
      });
      expect(f.observe).toHaveBeenCalledTimes(3 + maxReobserve);
      expect(f.act).toHaveBeenCalledTimes(2);
    }
  );
  it('never selects an option while a current ownership relation remains undeclared', async () => {
    const control = ownedControl();
    control.attributes = {
      ...control.attributes,
      'autofill-popup-state': 'pending',
      'autofill-popup': '',
    };
    const unowned = {
      ...ownedOption(),
      attributes: { 'autofill-node': 'unowned', 'autofill-popup-state': 'invalid' },
    };
    const f = fixture([control, unowned]);
    f.act.mockImplementation(async (_request, onDispatch) => {
      onDispatch();
    });
    const report = await runStrategy(
      {
        fields: [
          {
            match: { role: 'combobox', label: 'Location (City)' },
            option: { value: 'Chicago' },
            strategy: 'react-select',
          },
        ],
        policy: { maxReobserve: 1, settleMs: 0 },
      },
      f
    );
    expect(report.receipts[0]).toMatchObject({
      status: 'uncertain',
      error: { code: 'TARGET_NOT_FOUND' },
    });
    expect(f.act.mock.calls.map(([request]) => request.target?.ref)).toEqual(['owned', 'owned']);
  });
});
