/**
 * Edge-branch coverage for the autofill runner: block/field resolution
 * failures, skip and unsupported-strategy paths, dispatch-boundary
 * enforcement, widget strategy multi-step failures and final-verification
 * downgrade paths.
 */

import type { PageElement } from '@agentbrowser/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type AutofillPorts, runAutofill } from './autofill.js';

const textbox = (
  token: string,
  label: string,
  value = '',
  overrides: Partial<PageElement> = {}
): PageElement => ({
  ref: token,
  role: 'textbox',
  name: label,
  value,
  visible: true,
  enabled: true,
  attributes: {
    tag: 'input',
    type: 'text',
    'autofill-node': token,
    'autofill-block': 'block',
    'fieldset-id': 'block',
    'fieldset-label': 'Details',
  },
  ...overrides,
});

const combobox = (token: string, label: string): PageElement => ({
  ref: token,
  role: 'combobox',
  name: label,
  visible: true,
  enabled: true,
  attributes: {
    tag: 'div',
    'aria-autocomplete': 'list',
    'autofill-node': token,
    'autofill-block': 'block',
    'fieldset-id': 'block',
    'fieldset-label': 'Details',
    'autofill-focused': 'true',
    'autofill-popup': `${token}-popup`,
    'autofill-popup-state': 'ready',
  },
});

/** An option owned by the combobox's observed popup (post-typeahead state). */
const ownedChipOption = (token: string, owner: string, label: string): PageElement => ({
  ref: token,
  role: 'option',
  name: label,
  visible: true,
  enabled: true,
  attributes: {
    tag: 'li',
    'autofill-node': token,
    'autofill-block': 'block',
    'autofill-owner': owner,
    'autofill-owner-focused': 'true',
    'autofill-popup': `${owner}-popup`,
    'autofill-popup-state': 'ready',
  },
});

interface Fixture extends AutofillPorts {
  act: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  replace(next: PageElement[]): void;
  current(): PageElement[];
}

function fixture(initial: PageElement[]): Fixture {
  let elements = initial;
  const dispatch = vi.fn();
  const observe = vi.fn(async () => ({ elements }));
  const act = vi.fn(
    async (
      request: { action?: string; target?: { ref?: string }; value?: string },
      onDispatch: () => void
    ) => {
      onDispatch();
      dispatch();
      elements = elements.map((e) =>
        e.ref === request.target?.ref ? { ...e, value: request.value } : e
      );
    }
  );
  return {
    act,
    dispatch,
    observe,
    assert: vi.fn(),
    snapshot: vi.fn(async () => ({ artifactId: 'html' })),
    resolveValue: undefined,
    redact: undefined,
    replace: (next: PageElement[]) => {
      elements = next;
    },
    current: () => elements,
  };
}

const run = (f: Fixture, input: unknown) => runAutofill(input, f).catch((error: unknown) => error);

describe('autofill resolution failures', () => {
  it('refuses a block that matches zero or several observed fieldsets', async () => {
    const ambiguous = fixture([
      textbox('a', 'Company name', '', {
        attributes: {
          tag: 'input',
          type: 'text',
          'autofill-node': 'a',
          'autofill-block': 'tok-1',
          'fieldset-id': 'b1',
          'fieldset-label': 'Employment',
        },
      }),
      textbox('b', 'Company name', '', {
        attributes: {
          tag: 'input',
          type: 'text',
          'autofill-node': 'b',
          'autofill-block': 'tok-2',
          'fieldset-id': 'b1',
          'fieldset-label': 'Employment',
        },
      }),
    ]);
    const ambiguousReport = (await run(ambiguous, {
      fields: [{ match: { label: 'Company name', block: { id: 'b1' } }, value: 'x' }],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(ambiguousReport.receipts[0]?.error).toMatchObject({
      code: 'TARGET_AMBIGUOUS',
      message: 'Block must identify exactly one observed fieldset',
    });
    expect(ambiguous.act).not.toHaveBeenCalled();

    const missing = fixture([textbox('a', 'Company name')]);
    const missingReport = (await run(missing, {
      fields: [{ match: { label: 'Company name', block: { id: 'nope' } }, value: 'x' }],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(missingReport.receipts[0]?.error).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      message: 'Block must identify exactly one observed fieldset',
    });
    expect(missing.act).not.toHaveBeenCalled();
  });

  it('resolves fields by dataAutomationId', async () => {
    const f = fixture([
      textbox('a', 'Company name', '', {
        attributes: {
          tag: 'input',
          type: 'text',
          'autofill-node': 'a',
          'autofill-block': 'block',
          'fieldset-id': 'block',
          'fieldset-label': 'Details',
          'data-automation-id': 'co-input',
        },
      }),
    ]);
    const report = (await run(f, {
      fields: [{ match: { dataAutomationId: 'co-input' }, value: 'Acme' }],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.ok).toBe(true);
    expect(report.receipts[0]).toMatchObject({ resolvedRef: 'a', verified: true });
  });

  it('skips hidden and disabled controls without dispatching a write', async () => {
    const f = fixture([textbox('a', 'Company name', '', { visible: false })]);
    const report = (await run(f, {
      fields: [{ match: { label: 'Company name' }, value: 'x' }],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.receipts[0]).toMatchObject({
      status: 'skipped',
      resolvedRef: 'a',
      verified: false,
      error: { code: 'TARGET_NOT_VISIBLE' },
    });
    expect(f.act).not.toHaveBeenCalled();
  });

  it('refuses to write without node-identity evidence', async () => {
    const f = fixture([
      textbox('a', 'Company name', '', {
        attributes: { tag: 'input', type: 'text', 'autofill-block': 'block' },
      }),
    ]);
    const report = (await run(f, {
      fields: [{ match: { label: 'Company name' }, value: 'x' }],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.receipts[0]?.error).toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      message: 'No qualified widget strategy or node identity evidence; no write dispatched',
    });
    expect(f.act).not.toHaveBeenCalled();
  });
});

describe('autofill dispatch and policy corners', () => {
  it('refuses the write when the adapter never reports its dispatch boundary', async () => {
    const f = fixture([textbox('a', 'Company name')]);
    f.act.mockImplementation(async () => undefined); // never calls onDispatch
    const report = (await run(f, {
      fields: [{ match: { label: 'Company name' }, value: 'x' }],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.receipts[0]?.status).toBe('failed');
    expect(report.receipts[0]?.error).toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      message: 'Action adapter returned without reporting its dispatch boundary',
    });
  });

  it.fails('records the adapter action id on single-action receipts', async () => {
    // Known defect, expected to fail until fixed: autofill.ts declares an
    // outer `let effect` for the actionId evidence check, but both branches
    // bind their own shadowing `const effect`, so the outer variable is
    // never assigned and `receipt.actionId` stays unset even though the
    // adapter reported one. When the shadowing is fixed, this expectation
    // passes and should be promoted to a plain it().
    const f = fixture([textbox('a', 'Company name')]);
    f.act.mockImplementation(
      async (request: { target?: { ref?: string }; value?: string }, onDispatch: () => void) => {
        onDispatch();
        f.dispatch();
        f.replace([textbox('a', 'Company name', request.value ?? '')]);
        return { actionId: 'act_77' };
      }
    );
    const report = (await run(f, {
      fields: [{ match: { label: 'Company name' }, value: 'Acme' }],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.ok).toBe(true);
    expect(report.receipts[0]).toMatchObject({ status: 'verified', actionId: 'act_77' });
  });

  it('reports verify:none fields as unverified after dispatch', async () => {
    const f = fixture([textbox('a', 'Company name')]);
    const report = (await run(f, {
      fields: [{ match: { label: 'Company name' }, value: 'x', verify: 'none' }],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.ok).toBe(true);
    expect(report.receipts[0]).toMatchObject({ status: 'unverified', verified: false });
    expect(f.act).toHaveBeenCalledOnce();
    // No verification read after dispatch: exactly one observation happened.
    expect(f.observe).toHaveBeenCalledTimes(1);
  });

  it('skips ambiguous fields when the policy says skip and continues with the rest', async () => {
    const f = fixture([textbox('a', 'Company name'), textbox('b', 'Company name')]);
    const report = (await run(f, {
      fields: [
        { match: { label: 'Company name' }, value: 'x' },
        { match: { label: 'Company name' }, value: 'y' },
      ],
      policy: { onAmbiguous: 'skip', settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.receipts.map((r) => r.status)).toEqual(['skipped', 'skipped']);
    expect(report.receipts[0]?.error).toMatchObject({ code: 'TARGET_AMBIGUOUS' });
    expect(f.act).not.toHaveBeenCalled();
  });
});

describe('chip-multiselect strategy', () => {
  const chipRequest = {
    fields: [
      { match: { label: 'Team' }, option: { value: 'Alpha' }, strategy: 'chip-multiselect' },
    ],
    policy: { settleMs: 0 },
  };

  it('fails when no option survives typeahead filtering', async () => {
    const f = fixture([combobox('c1', 'Team')]);
    f.act.mockImplementation(async (request: { action?: string }, onDispatch: () => void) => {
      onDispatch();
      f.dispatch();
      void request;
    });
    const report = (await run(f, chipRequest)) as Awaited<ReturnType<typeof runAutofill>>;
    // The click and typeahead keystrokes were dispatched, so the failure is
    // reported as uncertain: the popup simply never presented a ready match.
    expect(report.receipts[0]).toMatchObject({
      status: 'uncertain',
      error: {
        code: 'TARGET_NOT_FOUND',
        message: 'No ready exact option in the owned popup',
      },
    });
  }, 15000);

  it('rejects malformed committed-members evidence as an unverified write', async () => {
    const f = fixture([combobox('c1', 'Team')]);
    f.act.mockImplementation(
      async (
        request: { action?: string; target?: { ref?: string }; value?: string },
        onDispatch: () => void
      ) => {
        onDispatch();
        f.dispatch();
        if (request.action === 'typeText') {
          // Typeahead reveals one owned, matching option.
          f.replace([combobox('c1', 'Team'), ownedChipOption('opt-1', 'c1', 'Alpha')]);
        }
        if (request.action === 'click' && request.target?.ref === 'opt-1') {
          // The control reports corrupt membership JSON instead of the array.
          f.replace([
            {
              ...combobox('c1', 'Team'),
              attributes: {
                ...combobox('c1', 'Team').attributes,
                'autofill-committed-members-complete': 'true',
                'autofill-committed-members': 'not-json-at-all',
              },
            },
          ]);
        }
      }
    );
    const report = (await run(f, chipRequest)) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.receipts[0]).toMatchObject({
      status: 'failed',
      verified: false,
      error: { code: 'VALUE_MISMATCH' },
    });
  }, 15000);
});

describe('final verification downgrades', () => {
  it('marks an earlier verified field uncertain when its control is swapped before the final pass', async () => {
    const f = fixture([textbox('a', 'Company A'), textbox('b', 'Company B')]);
    let writes = 0;
    f.act.mockImplementation(
      async (request: { target?: { ref?: string }; value?: string }, onDispatch: () => void) => {
        onDispatch();
        f.dispatch();
        writes += 1;
        if (writes === 1) {
          f.replace([textbox('a', 'Company A', request.value ?? ''), textbox('b', 'Company B')]);
        } else {
          // Filling B invalidates A: same label and block, different node.
          f.replace([
            textbox('a2', 'Company A', 'tampered', {
              attributes: {
                tag: 'input',
                type: 'text',
                'autofill-node': 'a2',
                'autofill-block': 'block',
                'fieldset-id': 'block',
                'fieldset-label': 'Details',
              },
            }),
            textbox('b', 'Company B', request.value ?? ''),
          ]);
        }
      }
    );
    const report = (await run(f, {
      fields: [
        { match: { label: 'Company A' }, value: 'A' },
        { match: { label: 'Company B' }, value: 'B' },
      ],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.ok).toBe(false);
    expect(report.receipts[0]).toMatchObject({
      status: 'uncertain',
      verified: false,
      error: { code: 'STALE_TARGET', message: 'Final field identity could not be verified' },
    });
    expect(report.receipts[1]).toMatchObject({ status: 'verified', verified: true });
  });

  it('downgrades every verified field when the final read is unavailable', async () => {
    const f = fixture([textbox('a', 'Company A'), textbox('b', 'Company B')]);
    // Reads 1-4 are the two per-field resolve+verify pairs; the final
    // verification read (5) is unavailable.
    f.observe.mockImplementation(async () => {
      if (f.observe.mock.calls.length >= 5) throw new Error('deadline hit');
      return { elements: f.current() };
    });
    const report = (await run(f, {
      fields: [
        { match: { label: 'Company A' }, value: 'A' },
        { match: { label: 'Company B' }, value: 'B' },
      ],
      policy: { settleMs: 0 },
    })) as Awaited<ReturnType<typeof runAutofill>>;
    expect(report.receipts.map((r) => [r.status, r.error?.code])).toEqual([
      ['uncertain', 'VERIFICATION_UNAVAILABLE'],
      ['uncertain', 'VERIFICATION_UNAVAILABLE'],
    ]);
    expect(report.snapshotError).toBeUndefined();
  });
});
