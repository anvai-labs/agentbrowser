import { createHash } from 'node:crypto';
import type { EnginePage, EngineSession, NativeFormEvidence } from '@agentbrowser/engine';
import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

const html = `<form id="application" name="draft" action="/save" method="post">
  <label>Full name<input id="fullName" name="fullName" value="Private Name" required></label>
  <fieldset id="current"><legend>Current</legend><label>Company<input id="currentCompany" value="Current"></label></fieldset>
  <fieldset id="previous"><legend>Previous</legend><label>Company<input id="previousCompany" value="Previous"></label></fieldset>
  <select id="preference"><option value="">Choose</option><option value="remote" selected>Remote</option></select>
  <select id="relocation"><option value="">Unanswered</option><option value="no" selected>No</option></select>
  <input id="referral" value=""><input id="terms" type="checkbox" checked>
  <input id="source" type="hidden" value="direct"><input id="resume" type="file" accept="application/pdf">
  <button id="remove" type="button">Remove attachment</button><button id="sync" type="button" disabled>Draft sync ready</button>
</form>`;
let engine: PlaywrightChromiumEngine;
beforeAll(() => {
  engine = new PlaywrightChromiumEngine();
});
afterAll(async () => {
  await engine.close();
});
async function fixture(test: (page: EnginePage, backing: Page) => Promise<void>, markup = html) {
  const session: EngineSession = await engine.createSession({ headless: true });
  try {
    const page = await session.newPage();
    const backing = (page as EnginePage & { backingPage(): Page }).backingPage();
    await backing.route('https://native-form.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: markup })
    );
    await backing.goto('https://native-form.test/apply');
    await test(page, backing);
  } finally {
    await session.close();
  }
}
function capture(page: EnginePage, signal?: AbortSignal): Promise<NativeFormEvidence> {
  if (!page.captureNativeForm) throw new Error('Missing native form capture');
  return page.captureNativeForm(signal ? { signal } : undefined);
}
const upload = (backing: Page, buffer = Buffer.from('real pdf bytes')) =>
  backing
    .locator('#resume')
    .setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer });

it('captures the complete native inventory, hidden values, committed selection and actual file digest', async () => {
  await fixture(async (page, backing) => {
    await upload(backing);
    const state = await capture(page);
    expect(state).toMatchObject({
      url: 'https://native-form.test/apply',
      form: {
        id: 'application',
        name: 'draft',
        action: 'https://native-form.test/save',
        method: 'post',
      },
    });
    expect(state.controls).toHaveLength(11);
    const byId = Object.fromEntries(state.controls.map((control) => [control.id, control]));
    expect(byId.source).toMatchObject({ type: 'hidden', value: 'direct', visible: false });
    expect(byId.preference).toMatchObject({
      value: 'remote',
      selectedIndex: 1,
      options: [
        { value: '', selected: false },
        { value: 'remote', selected: true },
      ],
    });
    expect(byId.terms).toMatchObject({ checked: true });
    expect(byId.sync).toMatchObject({ text: 'Draft sync ready', disabled: true });
    expect(byId.resume?.files).toEqual([
      expect.objectContaining({
        name: 'resume.pdf',
        type: 'application/pdf',
        size: 14,
        sha256: createHash('sha256').update('real pdf bytes').digest('hex'),
      }),
    ]);
    expect(byId.currentCompany?.blockId).not.toEqual(byId.previousCompany?.blockId);
    expect(byId.fullName?.blockId).toBeNull();
    const first = state.controls[0];
    if (!first) throw new Error('Missing fixture control');
    first.value = 'caller mutation';
    expect((await capture(page)).controls[0]?.value).toBe('Private Name');
  });
});
it('shares node and document identity with observations, including concurrent initialization', async () => {
  await fixture(async (page) => {
    if (!page.captureNativeForm) throw new Error('Missing native form capture');
    const [view, state] = await Promise.all([
      page.observe({ include: ['formControls'] }),
      capture(page),
    ]);
    const control = state.controls.find((control) => control.id === 'fullName');
    const observed = view.elements.find((element) => element.attributes?.id === 'fullName');
    expect(observed?.attributes?.['autofill-node']).toBe(control?.nodeId);
    expect(control?.nodeId.startsWith(`${state.documentId}:`)).toBe(true);
    const next = await capture(page);
    expect(next.documentId).toBe(state.documentId);
    expect(next.form.nodeId).toBe(state.form.nodeId);
  });
});
it.each(['navigate', 'same-url', 'document-open', 'set-content'] as const)(
  'changes document identity on %s',
  async (kind) => {
    await fixture(async (page, backing) => {
      const before = await capture(page);
      if (kind === 'navigate') await backing.goto('https://native-form.test/next');
      if (kind === 'same-url') await backing.reload();
      if (kind === 'document-open')
        await backing.evaluate((markup) => {
          document.open();
          document.write(markup);
          document.close();
        }, html);
      if (kind === 'set-content') await backing.setContent(html);
      const after = await capture(page);
      expect(after.documentId).not.toBe(before.documentId);
      expect(after.form.nodeId).not.toBe(before.form.nodeId);
    });
  }
);
it.each(['form', 'control'] as const)(
  'preserves document identity but detects replaced %s',
  async (kind) => {
    await fixture(async (page, backing) => {
      const before = await capture(page);
      await backing.evaluate((kind) => {
        const old = document.querySelector(kind === 'form' ? 'form' : '#fullName') as HTMLElement;
        old.replaceWith(old.cloneNode(true));
      }, kind);
      const after = await capture(page);
      expect(after.documentId).toBe(before.documentId);
      expect(after.controls[0]?.nodeId).not.toBe(before.controls[0]?.nodeId);
      expect(after.form.nodeId === before.form.nodeId).toBe(kind !== 'form');
    });
  }
);
it.each([
  ['extra-form', '<form></form>'],
  ['unassociated', '<input value="private">'],
  ['custom-widget', '<div role="combobox"></div>'],
  ['frame', '<iframe></iframe>'],
  ['custom-element', '<private-widget></private-widget>'],
  ['contenteditable', '<div contenteditable="true"></div>'],
])('refuses unsupported or incomplete inventory: %s', async (_name, extra) => {
  await fixture(async (page) => {
    await expect(capture(page)).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      message: 'Native form evidence unavailable',
    });
  }, html + extra);
});
it.each([
  'shadow',
  'multiple-select',
  'multiple-file',
  'unsupported-input',
  'extra-controls',
  'oversize-value',
  'oversize-file',
] as const)('refuses %s without partial evidence', async (kind) => {
  await fixture(async (page, backing) => {
    await backing.evaluate((kind) => {
      if (kind === 'shadow')
        document.body.appendChild(document.createElement('div')).attachShadow({ mode: 'open' });
      if (kind === 'multiple-select')
        (document.querySelector('select') as HTMLSelectElement).multiple = true;
      if (kind === 'multiple-file')
        (document.querySelector('#resume') as HTMLInputElement).multiple = true;
      if (kind === 'unsupported-input')
        (document.querySelector('#fullName') as HTMLInputElement).type = 'range';
      if (kind === 'extra-controls')
        for (let i = 0; i < 32; i++)
          (document.querySelector('form') as HTMLFormElement).appendChild(
            document.createElement('input')
          );
      if (kind === 'oversize-value')
        (document.querySelector('#fullName') as HTMLInputElement).value = 'private'.repeat(1000);
    }, kind);
    if (kind === 'oversize-file') await upload(backing, Buffer.alloc(32 * 1024 + 1));
    await expect(capture(page)).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      message: 'Native form evidence unavailable',
    });
  });
});
it('refuses pre-aborted capture before browser evaluation and sanitizes abort reason', async () => {
  await fixture(async (page, backing) => {
    const evaluate = vi.spyOn(backing, 'evaluate');
    const evaluateHandle = vi.spyOn(backing, 'evaluateHandle');
    const abort = new AbortController();
    abort.abort(new Error('PRIVATE'));
    await expect(capture(page, abort.signal)).rejects.toMatchObject({
      message: 'Native form evidence unavailable',
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(evaluateHandle).not.toHaveBeenCalled();
  });
});
it.each([
  'value',
  'file',
  'control',
  'form',
  'document',
  'abort',
  'options',
  'disabled',
  'required',
  'visibility',
  'action',
  'block',
] as const)('refuses %s changes during asynchronous file hashing', async (kind) => {
  await fixture(async (page, backing) => {
    await upload(backing);
    await backing.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        (window as unknown as { hashEntered: boolean }).hashEntered = true;
        await new Promise<void>((resolve) => {
          (window as unknown as { releaseHash: () => void }).releaseHash = resolve;
        });
        return original.call(this);
      };
    });
    const abort = new AbortController();
    const pending = capture(page, abort.signal);
    const refused = expect(pending).rejects.toMatchObject({
      message: 'Native form evidence unavailable',
    });
    await backing.waitForFunction(
      () => (window as unknown as { hashEntered?: boolean }).hashEntered,
      undefined,
      { timeout: 3000 }
    );
    if (kind === 'abort') abort.abort(new Error('PRIVATE'));
    await backing.evaluate(
      ({ kind, markup }) => {
        if (kind === 'value')
          (document.querySelector('#fullName') as HTMLInputElement).value = 'changed';
        if (kind === 'options')
          (document.querySelector('option') as HTMLOptionElement).text = 'changed';
        if (kind === 'disabled')
          (document.querySelector('#fullName') as HTMLInputElement).disabled = true;
        if (kind === 'required')
          (document.querySelector('#fullName') as HTMLInputElement).required = false;
        if (kind === 'visibility')
          (document.querySelector('#fullName') as HTMLInputElement).style.visibility = 'hidden';
        if (kind === 'action')
          (document.querySelector('form') as HTMLFormElement).action = '/changed';
        if (kind === 'block')
          (document.querySelector('#previous') as HTMLElement).append(
            document.querySelector('#currentCompany') as HTMLElement
          );
        if (kind === 'file') {
          const input = document.querySelector('#resume') as HTMLInputElement;
          const old = input.files?.[0];
          if (!old) throw new Error('Missing fixture file');
          const replacement = new DataTransfer();
          replacement.items.add(
            new File(['evil pdf bytes'], old.name, {
              type: old.type,
              lastModified: old.lastModified,
            })
          );
          input.files = replacement.files;
        }
        if (kind === 'control' || kind === 'form') {
          const old = document.querySelector(kind === 'form' ? 'form' : '#fullName') as HTMLElement;
          old.replaceWith(old.cloneNode(true));
        }
        if (kind === 'document') {
          document.open();
          document.write(markup);
          document.close();
        }
        (window as unknown as { releaseHash: () => void }).releaseHash();
      },
      { kind, markup: html }
    );
    await refused;
  });
});
it('includes externally associated and extra native controls in the exact inventory', async () => {
  await fixture(async (page, backing) => {
    const before = await capture(page);
    await backing.evaluate(() => {
      const extra = document.createElement('input');
      extra.id = 'extra';
      extra.setAttribute('form', 'application');
      extra.value = 'external';
      document.body.append(extra);
    });
    const after = await capture(page);
    expect(after.controls).toHaveLength(before.controls.length + 1);
    expect(after.controls.at(-1)).toMatchObject({ id: 'extra', value: 'external' });
  });
});
it('detects fieldset movement without replacing the control identity', async () => {
  await fixture(async (page, backing) => {
    const before = (await capture(page)).controls.find(
      (control) => control.id === 'currentCompany'
    );
    await backing.evaluate(() =>
      (document.querySelector('#previous') as HTMLElement).append(
        document.querySelector('#currentCompany') as HTMLElement
      )
    );
    const after = (await capture(page)).controls.find((control) => control.id === 'currentCompany');
    if (!before || !after) throw new Error('Missing fixture control');
    expect(after.nodeId).toBe(before.nodeId);
    expect(after.blockId).not.toBe(before.blockId);
  });
});
it('accepts exactly 32KiB actual file bytes', async () => {
  await fixture(async (page, backing) => {
    const bytes = Buffer.alloc(32 * 1024, 97);
    await upload(backing, bytes);
    expect(
      (await capture(page)).controls.find((control) => control.id === 'resume')?.files?.[0]
    ).toMatchObject({
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
});
it.each(['tree', 'aggregate', 'options', 'duplicate-id'] as const)(
  'refuses bounded capture overflow: %s',
  async (kind) => {
    await fixture(async (page, backing) => {
      await backing.evaluate((kind) => {
        if (kind === 'tree') {
          const fragment = document.createDocumentFragment();
          for (let i = 0; i < 10_000; i++) fragment.appendChild(document.createElement('span'));
          document.body.append(fragment);
        }
        if (kind === 'aggregate') {
          for (let i = 0; i < 18; i++) {
            const input = document.createElement('input');
            input.value = 'x'.repeat(4096);
            (document.querySelector('form') as HTMLFormElement).append(input);
          }
        }
        if (kind === 'options') {
          for (let i = 0; i < 33; i++)
            (document.querySelector('select') as HTMLSelectElement).append(
              new Option('Extra', 'extra')
            );
        }
        if (kind === 'duplicate-id') {
          const node = document.createElement('div');
          node.id = 'fullName';
          document.body.append(node);
        }
      }, kind);
      await expect(capture(page)).rejects.toMatchObject({
        message: 'Native form evidence unavailable',
      });
    });
  }
);
it('sanitizes private DOM getter failures', async () => {
  await fixture(async (page, backing) => {
    await backing.evaluate(() =>
      Object.defineProperty(document.querySelector('#fullName'), 'value', {
        get() {
          throw new Error('PRIVATE VALUE');
        },
      })
    );
    await expect(capture(page)).rejects.toMatchObject({
      message: 'Native form evidence unavailable',
    });
  });
});
it('refuses a disabled optgroup whose selected option reports disabled=false', async () => {
  await fixture(async (page, backing) => {
    await backing.evaluate(() => {
      const select = document.querySelector('#preference') as HTMLSelectElement;
      const group = document.createElement('optgroup');
      group.label = 'Unavailable';
      group.disabled = true;
      const option = new Option('Remote', 'remote', true, true);
      group.append(option);
      select.replaceChildren(group);
      select.value = 'remote';
    });
    expect(
      await backing
        .locator('#preference option')
        .evaluate((option) => (option as HTMLOptionElement).disabled)
    ).toBe(false);
    await expect(capture(page)).rejects.toMatchObject({
      code: 'ENGINE_UNSUPPORTED',
      message: 'Native form evidence unavailable',
    });
  });
});
