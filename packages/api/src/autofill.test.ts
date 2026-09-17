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

  describe('multi-step widget strategies', () => {
    const rsCombobox = (ref: string, committed = ''): PageElement => ({
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
        'autofill-block': 'rs-block',
        ...(committed ? { 'autofill-committed': committed } : {}),
      },
    });

    it('react-select: click-open, typeText filter, click exact option, verified via chip', async () => {
      const f = fixture([]);
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
                attributes: { tag: 'li', 'autofill-node': 'opt_1', 'autofill-block': 'rs-block' },
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
      const report = await runAutofill(
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

    it('react-select: no matching option produces TARGET_NOT_FOUND, no write dispatched', async () => {
      const f = fixture([]);
      // click opens the menu but typing filters to nothing
      f.act.mockImplementation(async (request: { action: string }, onDispatch: () => void) => {
        onDispatch();
        f.dispatch();
        if (request.action === 'typeText') {
          f.replace([rsCombobox('rs_1')]); // no options appear
        }
      });
      const report = await runAutofill(
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
      expect(report.receipts[0].status).toBe('failed');
      expect(report.receipts[0].error?.code).toBe('TARGET_NOT_FOUND');
    });

    it('chip-multiselect: click-open, typeText filter, click chip option, verified via chip', async () => {
      const f = fixture([]);
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
              rsCombobox('ms_1'),
              {
                ...rsCombobox('ms_1'),
                ref: chipRef,
                role: 'option',
                name: 'United States of America, press delete to clear value.',
                value: undefined,
                attributes: { tag: 'li', 'autofill-node': 'chip_1', 'autofill-block': 'ms-block' },
              },
            ]);
          }
          if (request.action === 'click' && request.target?.ref === chipRef) {
            f.replace([{ ...rsCombobox('ms_1'), ref: 'ms_1', name: 'Country Phone Code' }]);
          }
        }
      );
      const report = await runAutofill(
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

    it('strategy refusal: react-select combobox without option.value produces INVALID_REQUEST', async () => {
      const f = fixture([]);
      f.act.mockImplementation(async (request: Record<string, unknown>, onDispatch: () => void) => {
        onDispatch();
        f.dispatch();
      });
      const report = await runAutofill(
        {
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              strategy: 'react-select',
            },
          ],
        },
        { ...f, act: f.act }
      );
      expect(report.ok).toBe(false);
      expect(report.receipts[0].status).toBe('failed');
    });
  });
});
