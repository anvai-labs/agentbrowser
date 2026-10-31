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
  it('withheld verification on a sensitive control keeps filling the remaining fields', async () => {
    const otp: PageElement = { ...field('otp', 'one'), name: 'Code' };
    const device: PageElement = { ...field('dev', 'two'), name: 'Device name' };
    const redact = (element: PageElement): PageElement => {
      const { value: _withheld, ...rest } = element;
      return { ...rest, valueRedacted: true };
    };
    let filledOtp = false;
    let filledDevice = '';
    const f = fixture([otp, device]);
    f.act.mockImplementation(
      async (request: { target?: { ref?: string }; value?: string }, onDispatch: () => void) => {
        onDispatch();
        f.dispatch();
        if (request.target?.ref === 'otp') {
          filledOtp = true;
          // Post-fill observation of a policy-sensitive control: value
          // withheld by the engine's redaction boundary.
          f.replace([redact(otp), device]);
        } else {
          filledDevice = String(request.value ?? '');
          f.replace([redact(otp), { ...device, value: filledDevice }]);
        }
      }
    );
    const report = await runAutofill(
      {
        fields: [
          { match: { label: 'Code' }, value: '123456' },
          { match: { label: 'Device name' }, value: 'YubiKey 5C' },
        ],
        policy: { settleMs: 0 },
      },
      f
    );
    expect(filledOtp).toBe(true);
    expect(filledDevice).toBe('YubiKey 5C');
    expect(f.act).toHaveBeenCalledTimes(2);
    // A withheld receipt never aborts the loop, never reports a mismatch, and
    // never leaks the value — retrying a "failed" report would double-write
    // the credential.
    expect(report.receipts[0]).toMatchObject({
      status: 'unverified',
      verified: false,
      verificationWithheld: true,
    });
    expect(report.receipts[0]?.actual).toBeUndefined();
    expect(report.receipts[1]).toMatchObject({ status: 'verified', verified: true });
    expect(report.ok).toBe(true);
  });

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

  describe('chip-multiselect exact set (W2)', () => {
    const multi = (ref: string, members: readonly string[]): PageElement => {
      const base = chipCombobox(ref, members);
      return { ...base, attributes: { ...base.attributes, 'autofill-multi': 'true' } };
    };
    const remover = (ref: string, owner: string, label: string): PageElement => ({
      ref,
      role: 'button',
      name: `Remove ${label}`,
      visible: true,
      enabled: true,
      attributes: {
        tag: 'div',
        'autofill-node': ref,
        'autofill-block': 'ms-block',
        'autofill-chip-owner': owner,
        'autofill-chip-label': label,
      },
    });
    const exactField = (values: string[]) => ({
      fields: [
        {
          match: { role: 'combobox', label: 'Country Phone Code' },
          options: { values, mode: 'exact' as const },
          strategy: 'chip-multiselect' as const,
        },
      ],
      policy: { settleMs: 0 },
    });

    it.each([
      ['a control not proven multi-valued', [chipCombobox('ms_x', ['A'])], 'ENGINE_UNSUPPORTED'],
      ['duplicate chip labels', [multi('ms_x', ['A', 'A'])], 'TARGET_AMBIGUOUS'],
      ['no remove control for an extra chip', [multi('ms_x', ['A'])], 'ENGINE_UNSUPPORTED'],
      [
        'two remove controls for one chip',
        [multi('ms_x', ['A']), remover('r1', 'ms_x', 'A'), remover('r2', 'ms_x', 'A')],
        'TARGET_AMBIGUOUS',
      ],
      [
        "only another widget's remove control",
        [multi('ms_x', ['A']), remover('r1', 'other', 'A')],
        'ENGINE_UNSUPPORTED',
      ],
    ])('refuses %s before any dispatch', async (_name, elements, code) => {
      const f = fixture(elements as PageElement[]);
      const report = await runStrategy(exactField([]), f);
      expect(report.receipts[0]).toMatchObject({ status: 'failed', error: { code } });
      expect(report.receipts[0]?.effects).toBeUndefined();
      expect(f.dispatch).not.toHaveBeenCalled();
    });

    it('removes an extra chip through its own remove control and records the effect', async () => {
      const f = fixture([
        multi('ms_x', ['A', 'B']),
        remover('rA', 'ms_x', 'A'),
        remover('rB', 'ms_x', 'B'),
      ]);
      f.act.mockImplementation(
        async (request: { action: string; target?: { ref?: string } }, onDispatch: () => void) => {
          onDispatch();
          f.dispatch();
          if (request.action === 'click' && request.target?.ref === 'rA')
            f.replace([multi('ms_x', ['B']), remover('rB', 'ms_x', 'B')]);
        }
      );
      const report = await runStrategy(exactField(['B']), { ...f, act: f.act });
      expect(f.act).toHaveBeenCalledTimes(1);
      expect(f.act.mock.calls[0]?.[0]).toMatchObject({ action: 'click', target: { ref: 'rA' } });
      expect(report.receipts[0]).toMatchObject({
        status: 'verified',
        effects: { removed: ['A'], added: [] },
      });
    });

    it('refuses an extra chip whose remove control has no owned remover, before dispatch', async () => {
      const f = fixture([multi('ms_x', ['B', 'C'])]);
      const report = await runStrategy(exactField(['B']), f);
      expect(report.receipts[0]).toMatchObject({
        status: 'failed',
        error: { code: 'ENGINE_UNSUPPORTED' },
      });
      expect(f.dispatch).not.toHaveBeenCalled();
    });

    it('refuses a hidden remove control before dispatch', async () => {
      const hidden = { ...remover('rA', 'ms_x', 'A'), visible: false };
      const f = fixture([multi('ms_x', ['A']), hidden]);
      const report = await runStrategy(exactField([]), f);
      expect(report.receipts[0]).toMatchObject({
        status: 'failed',
        error: { code: 'TARGET_NOT_VISIBLE' },
      });
      expect(f.dispatch).not.toHaveBeenCalled();
    });

    it('records no removal effect when the click does not actually remove the chip', async () => {
      const f = fixture([multi('ms_x', ['A']), remover('rA', 'ms_x', 'A')]);
      f.act.mockImplementation(async (_request, onDispatch: () => void) => {
        onDispatch();
        f.dispatch(); // the click lands but the widget keeps the chip
      });
      const report = await runStrategy(exactField([]), { ...f, act: f.act });
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      expect(report.receipts[0]?.status).toBe('uncertain');
      expect(report.receipts[0]?.effects).toBeUndefined();
    });

    it('records no add effect when the chosen option never becomes a member', async () => {
      const f = fixture([multi('ms_add', [])]);
      f.act.mockImplementation(
        async (request: { action: string; target?: { ref?: string } }, onDispatch: () => void) => {
          onDispatch();
          f.dispatch();
          if (request.action === 'typeText')
            f.replace([
              multi('ms_add', []),
              {
                ...rsCombobox('ms_add'),
                ref: 'opt_a',
                role: 'option',
                name: 'A',
                value: undefined,
                attributes: {
                  ...ownedOption('opt_a', '', 'ms_add').attributes,
                  tag: 'li',
                  'autofill-node': 'opt_a',
                  'autofill-block': 'ms-block',
                },
              },
            ]);
          // Clicking the option commits nothing: membership stays empty.
          if (request.action === 'click' && request.target?.ref === 'opt_a')
            f.replace([multi('ms_add', [])]);
        }
      );
      const report = await runStrategy(exactField(['A']), { ...f, act: f.act });
      expect(report.receipts[0]?.status).toBe('uncertain');
      expect(report.receipts[0]?.effects).toBeUndefined();
    });

    const changesAfterRun = (finalElement: PageElement, exact: string[] = ['A']) => {
      // Observations before verification (resolve, initial membership, the add loop) see the
      // exact set; the verification observation sees `finalElement`.
      const f = fixture([multi('ms_v', exact)]);
      let calls = 0;
      const observe = vi.fn(async () => {
        calls += 1;
        return { elements: [calls <= 2 + exact.length ? multi('ms_v', exact) : finalElement] };
      });
      return { ...f, observe };
    };

    it.each([
      ['a missing member (size check)', multi('ms_v', ['A'])],
      ['a duplicate that matches the size (duplicate check)', multi('ms_v', ['A', 'A'])],
    ])('exact verification of {A, B} fails on %s', async (_name, finalElement) => {
      const report = await runStrategy(
        exactField(['A', 'B']),
        changesAfterRun(finalElement as PageElement, ['A', 'B'])
      );
      expect(report.receipts[0]).toMatchObject({
        status: 'failed',
        verified: false,
        error: { code: 'VALUE_MISMATCH' },
      });
    });

    it.each([
      ['an extra member', multi('ms_v', ['A', 'C'])],
      ['a duplicated member', multi('ms_v', ['A', 'A'])],
      [
        'a control no longer proven multi-valued',
        (() => {
          const element = multi('ms_v', ['A']);
          const { 'autofill-multi': _dropped, ...rest } = element.attributes ?? {};
          return { ...element, attributes: rest };
        })(),
      ],
    ])('exact verification fails on %s', async (_name, finalElement) => {
      const report = await runStrategy(
        exactField(['A']),
        changesAfterRun(finalElement as PageElement)
      );
      expect(report.receipts[0]).toMatchObject({
        status: 'failed',
        verified: false,
        error: { code: 'VALUE_MISMATCH' },
      });
    });

    it('redacts effect labels through the port', async () => {
      const f = fixture([multi('ms_r', ['SECRET-A', 'B']), remover('rA', 'ms_r', 'SECRET-A')]);
      f.act.mockImplementation(
        async (request: { action: string; target?: { ref?: string } }, onDispatch: () => void) => {
          onDispatch();
          f.dispatch();
          if (request.target?.ref === 'rA') f.replace([multi('ms_r', ['B'])]);
        }
      );
      const report = await runStrategy(exactField(['B']), {
        ...f,
        act: f.act,
        redact: (value: string) => value.replace('SECRET-A', '[redacted]'),
      });
      expect(report.receipts[0]?.effects).toEqual({ removed: ['[redacted]'], added: [] });
    });
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
    ).rejects.toThrow('exactly one of value, option.value or options.values');
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

describe('unscoped recheck (B-dur, review round 2)', () => {
  const title = (token: string): PageElement => ({ ...field(token, 'two'), name: 'Title' });
  const request = () => ({
    fields: [
      { match: { label: 'Company name' }, value: 'First', strategy: 'native-input' as const },
      { match: { label: 'Title' }, value: 'Lead', strategy: 'native-input' as const },
    ],
    policy: { settleMs: 0, maxReobserve: 3 },
  });

  it('checks only fields the run committed to: a later field not yet revealed is fine', async () => {
    const f = fixture([field('a', 'one')]);
    let recheck: (() => Promise<void>) | undefined;
    let atFirstDispatch: unknown = 'not called';
    const act = f.act;
    let first = true;
    await runAutofill(request(), {
      ...f,
      onRecheck: (offered) => {
        recheck = offered;
      },
      act: async (wire, onDispatch) => {
        if (first) {
          first = false;
          // B-dur-2's placement: before the first effect. 'Title' is not on the page yet.
          atFirstDispatch = await recheck?.().then(
            () => 'passed',
            (error: unknown) => error
          );
          const result = await act(wire, onDispatch);
          // The write reveals the next field, as conditional forms do.
          f.replace([field('a', 'one', 'First'), title('t')]);
          return result;
        }
        return act(wire, onDispatch);
      },
    });
    expect(atFirstDispatch).toBe('passed');
  });

  it('refuses when a committed field was replaced by another node during the wait', async () => {
    const f = fixture([field('a', 'one'), title('t')]);
    let recheck: (() => Promise<void>) | undefined;
    let atFirstDispatch: unknown = 'not called';
    const act = f.act;
    let first = true;
    await runAutofill(request(), {
      ...f,
      onRecheck: (offered) => {
        recheck = offered;
      },
      act: async (wire, onDispatch) => {
        if (first) {
          first = false;
          // During the wait the committed control is re-rendered as a different node.
          f.replace([field('a2', 'one'), title('t')]);
          atFirstDispatch = await recheck?.().then(
            () => 'passed',
            (error: unknown) => error
          );
          throw new Error('stop');
        }
        return act(wire, onDispatch);
      },
    });
    expect(atFirstDispatch).toMatchObject({ code: 'STALE_TARGET' });
  });
});

describe('mapped stage scope and preflight', () => {
  const url = 'https://example.test/apply?id=123';
  const request = () => ({
    scope: { url },
    fields: [
      {
        match: { label: 'Company name', block: { id: 'one' } },
        value: 'First',
        strategy: 'native-input',
      },
      {
        match: { label: 'Company name', block: { id: 'two' } },
        value: 'Second',
        strategy: 'native-input',
      },
    ],
    policy: { settleMs: 0, maxReobserve: 0 },
  });
  const scopedFixture = () => {
    const f = fixture([field('a', 'one'), field('b', 'two')]);
    const read = f.observe.getMockImplementation()!;
    f.observe.mockImplementation(async () => ({ ...(await read()), url }));
    return { ...f, resolveValue: vi.fn(async (value: string) => value) };
  };
  it('offers its own scoped recheck once (B-dur, B6): current page passes, a changed one is refused', async () => {
    const f = scopedFixture();
    const offered: Array<() => Promise<void>> = [];
    const report = await runAutofill(request(), {
      ...f,
      onRecheck: (recheck) => offered.push(recheck),
    });
    expect(report.ok).toBe(true);
    expect(offered).toHaveLength(1);
    const recheck = offered[0] as () => Promise<void>;
    // The page as the run pinned it: the recheck passes and dispatches nothing.
    const before = f.dispatch.mock.calls.length;
    await expect(recheck()).resolves.toBeUndefined();
    expect(f.dispatch).toHaveBeenCalledTimes(before);
    // During a wait, the second block's control is replaced by another node: identity changed.
    f.replace([field('a', 'one'), field('c', 'two')]);
    await expect(recheck()).rejects.toMatchObject({ code: 'STALE_TARGET' });
    // Or the page navigated away from the mapped stage.
    f.observe.mockResolvedValue({
      elements: [field('a', 'one'), field('b', 'two')],
      url: 'https://other.test/apply',
    } as never);
    await expect(recheck()).rejects.toMatchObject({ code: 'FORM_SCOPE_MISMATCH' });
  });
  it('the recheck is read-only: passing inside a failed dispatch never re-authorizes the snapshot (review M2)', async () => {
    const f = scopedFixture();
    let recheck: (() => Promise<void>) | undefined;
    const act = f.act;
    let first = true;
    const report = await runAutofill(request(), {
      ...f,
      onRecheck: (offered) => {
        recheck = offered;
      },
      act: async (wire, onDispatch) => {
        if (first) {
          first = false;
          onDispatch();
          // B-dur-2's placement: after the marker, inside the dispatch. The page is unchanged,
          // so the recheck passes — and the effect then fails.
          await recheck?.();
          throw new Error('page handler threw after dispatch');
        }
        return act(wire, onDispatch);
      },
    });
    expect(report.ok).toBe(false);
    // The dispatch revoked scope validity; nothing re-observed after it, so no raw capture.
    expect(f.snapshot).not.toHaveBeenCalled();
  });
  it('refuses a recheck before preflight recorded any pins (review M2)', async () => {
    const f = scopedFixture();
    let recheck: (() => Promise<void>) | undefined;
    let early: unknown = 'not called';
    const read = f.observe.getMockImplementation()!;
    f.observe.mockImplementationOnce(async () => {
      // Inside the preflight's first observation, before any pin exists: capture the outcome
      // here and assert it OUTSIDE the run (the run would swallow an assertion error).
      early = await recheck?.().then(
        () => 'passed',
        (error: unknown) => error
      );
      return read();
    });
    await runAutofill(request(), {
      ...f,
      onRecheck: (offered) => {
        recheck = offered;
      },
    });
    expect(early).toMatchObject({ code: 'STALE_TARGET' });
  });
  it('preflights repeated labels in separate blocks and runs the existing executor', async () => {
    const f = scopedFixture();
    const report = await runAutofill(request(), f);
    expect(report.ok).toBe(true);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.resolveValue).toHaveBeenCalledTimes(2);
  });
  it.each([
    'wrong-url',
    'missing-url',
    'truncated',
    'degraded',
    'missing-later',
    'ambiguous-later',
    'hidden-later',
    'unsupported-later',
    'duplicate-target',
  ])('refuses %s before any write or private reference resolution', async (kind) => {
    const f = scopedFixture();
    const input = request();
    if (kind === 'wrong-url')
      f.observe.mockResolvedValue({
        elements: [field('a', 'one'), field('b', 'two')],
        url: 'https://other.test/apply',
      } as never);
    if (kind === 'missing-url')
      f.observe.mockResolvedValue({ elements: [field('a', 'one'), field('b', 'two')] });
    if (kind === 'truncated' || kind === 'degraded')
      f.observe.mockResolvedValue({
        elements: [field('a', 'one'), field('b', 'two')],
        url,
        [kind]: true,
      } as never);
    if (kind === 'missing-later') f.replace([field('a', 'one')]);
    if (kind === 'ambiguous-later')
      f.replace([field('a', 'one'), field('b', 'two'), field('c', 'two')]);
    if (kind === 'hidden-later')
      f.replace([field('a', 'one'), { ...field('b', 'two'), visible: false }]);
    if (kind === 'unsupported-later')
      f.replace([
        field('a', 'one'),
        { ...field('b', 'two'), attributes: { ...field('b', 'two').attributes, type: 'password' } },
      ]);
    if (kind === 'duplicate-target') input.fields[1]!.match.block.id = 'one';
    const report = await runAutofill(input, f);
    expect(report.ok).toBe(false);
    const fieldSpecific = [
      'missing-later',
      'ambiguous-later',
      'hidden-later',
      'unsupported-later',
      'duplicate-target',
    ].includes(kind);
    expect(report.receipts.map((r) => r.status)).toEqual(
      fieldSpecific ? ['not_attempted', 'failed'] : ['failed', 'not_attempted']
    );
    expect(report.receipts.every((r) => !r.verified)).toBe(true);
    expect(f.act).not.toHaveBeenCalled();
    expect(f.resolveValue).not.toHaveBeenCalled();
    expect(f.snapshot).not.toHaveBeenCalled();
  });
  it.each([
    'replacement',
    'block-move',
    'selector-drift',
    'url-drift',
    'hidden-later',
    'disabled-later',
  ])('stops after a first field changes the remaining mapped stage: %s', async (kind) => {
    const f = scopedFixture();
    f.act.mockImplementationOnce(async (_action, onDispatch) => {
      onDispatch();
      f.dispatch();
      let next = field('b', 'two');
      if (kind === 'hidden-later') next = { ...next, visible: false };
      if (kind === 'disabled-later') next = { ...next, enabled: false };
      if (kind === 'replacement') next = field('new', 'two');
      if (kind === 'block-move') next = field('b', 'other');
      if (kind === 'selector-drift') next = { ...next, name: 'Changed' };
      f.replace([field('a', 'one', 'First'), next]);
      if (kind === 'url-drift')
        f.observe.mockResolvedValue({
          elements: [field('a', 'one', 'First'), next],
          url: `${url}4`,
        } as never);
    });
    const report = await runAutofill(request(), f);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(report.receipts.map((r) => r.status)).toEqual(['uncertain', 'not_attempted']);
    expect(f.snapshot).not.toHaveBeenCalled();
  });
  it('rechecks scope after a private resolver changes the page, before writing', async () => {
    const f = scopedFixture();
    f.resolveValue.mockImplementationOnce(async (value) => {
      f.replace([field('a', 'one'), field('replacement', 'two')]);
      return value;
    });
    const report = await runAutofill(request(), f);
    expect(report.ok).toBe(false);
    expect(f.act).not.toHaveBeenCalled();
  });
});

it('accepts scoped engine identity for a control outside any fieldset', async () => {
  const f = fixture([field('a', '')]);
  const read = f.observe.getMockImplementation()!;
  const url = 'https://example.test/';
  f.observe.mockImplementation(async () => ({ ...(await read()), url }));
  const report = await runAutofill(
    {
      scope: { url },
      fields: [{ match: { label: 'Company name' }, strategy: 'native-input', value: 'Top level' }],
      policy: { settleMs: 0 },
    },
    f
  );
  expect(report.ok).toBe(true);
  expect(f.dispatch).toHaveBeenCalledOnce();
});
it('never exports an artifact from stale scope after dispatch rejects before verification', async () => {
  const f = fixture([field('a', 'one')]);
  const url = 'https://example.test/';
  f.observe.mockResolvedValue({ elements: [field('a', 'one')], url } as never);
  f.act.mockImplementationOnce(async (_request, onDispatch) => {
    onDispatch();
    f.dispatch();
    f.observe.mockResolvedValue({
      elements: [field('a', 'one')],
      url: 'https://other.test/',
    } as never);
    throw new Error('navigation after dispatch');
  });
  const report = await runAutofill(
    {
      scope: { url },
      fields: [{ match: { label: 'Company name' }, strategy: 'native-input', value: 'x' }],
    },
    f
  );
  expect(report.receipts[0]?.status).toBe('uncertain');
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.snapshot).not.toHaveBeenCalled();
});

describe('consumer autofill diagnostics', () => {
  it('retains dispatch uncertainty and sanitized cause without replaying the prefix', async () => {
    const f = fixture([field('a', 'one'), { ...field('b', 'two'), name: 'Other' }]);
    f.act.mockImplementationOnce(async (_request, onDispatch) => {
      onDispatch();
      f.replace([field('a', 'one', 'x')]);
      throw Object.assign(new Error('private-value https://site.test/?token=private'), {
        code: 'STALE_TARGET',
      });
    });
    const report = await runAutofill(
      {
        fields: [
          { match: { label: 'Company name', block: { id: 'one' } }, value: 'x' },
          { match: { label: 'Other' }, value: 'y' },
        ],
        policy: { settleMs: 0 },
      },
      f
    );
    expect(report.receipts.map((r) => r.status)).toEqual(['uncertain', 'not_attempted']);
    expect(report.receipts[0]?.error?.code).toBe('STALE_TARGET');
    expect(report.diagnostics).toMatchObject({
      deadlineMode: 'cooperative',
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'dispatch', calls: 1, errorCode: 'STALE_TARGET' }),
      ]),
    });
    expect(JSON.stringify(report)).not.toContain('private');
    expect(f.act).toHaveBeenCalledOnce();
  });

  it('reports a cooperative budget overrun and stops subsequent writes', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const f = fixture([field('a', 'one')]);
      f.act.mockImplementationOnce(async (_request, onDispatch) => {
        onDispatch();
        now = 40120;
      });
      const report = await runAutofill(
        {
          fields: [
            { match: { label: 'Company name' }, value: 'x' },
            { match: { label: 'Other' }, value: 'y' },
          ],
          policy: { timeoutMs: 30000, settleMs: 0 },
        },
        f
      );
      expect(report.receipts.map((r) => r.status)).toEqual(['uncertain', 'not_attempted']);
      expect(report.receipts[0]?.error?.code).toBe('ACTION_TIMEOUT');
      expect(report.diagnostics).toMatchObject({ deadlineMode: 'cooperative', overrunMs: 10120 });
      expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.act).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('distinguishes artifact-only failure from final verification failure', async () => {
    const f = fixture([field('a', 'one')]);
    f.snapshot.mockRejectedValueOnce(new Error('private html'));
    const report = await runAutofill(
      { fields: [{ match: { label: 'Company name' }, value: 'x' }], policy: { settleMs: 0 } },
      f
    );
    expect(report.ok).toBe(true);
    expect(report.receipts[0]?.verified).toBe(true);
    expect(report.diagnostics?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'final_verification', calls: 1 }),
        expect.objectContaining({ stage: 'artifact', errorCode: 'ACTION_FAILED' }),
      ])
    );
    expect(report.snapshotError).toContain('ACTION_FAILED');
    expect(JSON.stringify(report.diagnostics)).not.toContain('private');
  });
});
