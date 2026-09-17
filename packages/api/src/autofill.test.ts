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

  describe('react-select keyboard commit', () => {
    /** Models the live Greenhouse react-select: the combobox is an input with
     *  aria-autocomplete=list. Option clicks fire but don't commit. Keyboard
     *  ArrowDown+Enter after typeText DOES commit. The committed chip text
     *  appears as autofill-committed on the element. */
    function rsFixture() {
      const combobox: PageElement = {
        ref: 'rs_in',
        role: 'combobox',
        name: 'Location (City)',
        value: '',
        visible: true,
        enabled: true,
        attributes: {
          tag: 'input',
          'aria-autocomplete': 'list',
          'autofill-node': 'rs_node',
          'autofill-block': 'rs_blk',
        },
      };
      const elements = [combobox];
      let committed = false;
      const pressKeys: string[] = [];
      const clickTargets: string[] = [];
      return {
        get committed() {
          return committed;
        },
        get pressKeys() {
          return pressKeys;
        },
        get clickTargets() {
          return clickTargets;
        },
        ports: {
          assert: vi.fn(),
          snapshot: vi.fn(async () => ({ artifactId: 'snap' })),
          observe: vi.fn(async () => {
            const els: PageElement[] = elements.map((e) => ({
              ...e,
              attributes: committed
                ? { ...e.attributes, 'autofill-committed': 'Chicago, Illinois, United States' }
                : { ...e.attributes },
            }));
            // After the menu opens, show the filtered options
            if (pressKeys.length > 0 || elements.some((e) => (e.value ?? '') !== '')) {
              els.push(
                {
                  ref: 'opt_0',
                  role: 'option',
                  name: 'Chicago, Illinois, United States',
                  value: undefined,
                  visible: true,
                  enabled: true,
                  attributes: { tag: 'li', 'autofill-node': 'opt_node_0', 'autofill-block': '' },
                } as PageElement,
                {
                  ref: 'opt_1',
                  role: 'option',
                  name: 'Chicago Heights, Illinois, United States',
                  value: undefined,
                  visible: true,
                  enabled: true,
                  attributes: { tag: 'li', 'autofill-node': 'opt_node_1', 'autofill-block': '' },
                } as PageElement
              );
            }
            return { elements: els };
          }),
          act: vi.fn(async (request: Record<string, unknown>, onDispatch: () => void) => {
            onDispatch();
            const action = request.action as string;
            if (action === 'typeText') {
              // Typing populates the input; the menu filters
            } else if (action === 'press') {
              pressKeys.push(request.key as string);
              if (request.key === 'Enter') {
                // Keyboard commit: react-select selects the highlighted option
                committed = true;
              }
            } else if (action === 'click') {
              clickTargets.push((request.target as { ref?: string })?.ref ?? '');
            }
          }),
        },
      };
    }

    it('commits via keyboard ArrowDown+Enter, never clicks option refs', async () => {
      const f = rsFixture();
      const report = await runAutofill(
        {
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              option: { value: 'Chicago, Illinois, United States' },
              strategy: 'react-select',
            },
          ],
          policy: { settleMs: 0 },
        },
        f.ports
      );
      // Keyboard commit was used
      expect(f.pressKeys).toContain('ArrowDown');
      expect(f.pressKeys).toContain('Enter');
      // No option refs were clicked (click-commit doesn't work on this widget class)
      const optionClicks = f.clickTargets.filter((r) => r.startsWith('opt_'));
      expect(optionClicks).toHaveLength(0);
      // The receipt is verified (the committed state matches the expected)
      expect(report.ok).toBe(true);
      expect(report.receipts[0]?.status).toBe('verified');
    });

    it('verification checks autofill-committed when a11y value stays empty', async () => {
      const f = rsFixture();
      const report = await runAutofill(
        {
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              option: { value: 'Chicago, Illinois, United States' },
              strategy: 'react-select',
            },
          ],
          policy: { settleMs: 0 },
        },
        f.ports
      );
      // After commit, the a11y value stays empty but autofill-committed captures the chip
      // The verification should check autofill-committed as evidence of the commit
      expect(report.receipts[0]?.verified).toBe(true);
      // The receipt's actual field shows the a11y value (empty), not the chip text
      // because the display function reads same.value (the input's a11y value)
      // This is correct: the chip text is in the committed attribute, not the value
    });
  });

  describe('autofill-committed verification', () => {
    it('verifies via autofill-committed when a11y value is empty', async () => {
      const el: PageElement = {
        ref: 'combo_1',
        role: 'combobox',
        name: 'Location (City)',
        value: '',
        visible: true,
        enabled: true,
        attributes: {
          tag: 'input',
          'autofill-node': 'combo_node_1',
          'autofill-block': 'blk',
          'autofill-committed': 'Chicago, Illinois, United States',
        },
      };
      const report = await runAutofill(
        {
          fields: [
            {
              match: { role: 'combobox', label: 'Location (City)' },
              option: { value: 'Chicago, Illinois, United States' },
            },
          ],
          policy: { settleMs: 0 },
        },
        {
          assert: vi.fn(),
          snapshot: vi.fn(async () => ({ artifactId: 'snap' })),
          observe: vi.fn(async () => ({ elements: [el] })),
          act: vi.fn(async (_request, onDispatch: () => void) => {
            onDispatch();
          }),
        }
      );
      expect(report.ok).toBe(true);
      expect(report.receipts[0]?.verified).toBe(true);
    });
  });
});
