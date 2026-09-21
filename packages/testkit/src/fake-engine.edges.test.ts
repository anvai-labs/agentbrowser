/**
 * Edge-behavior tests for FakeEngine
 *
 * Complements fake-engine.test.ts by pinning the corners of the fake:
 * test-handle lookup, popup emulation, dead-page guards, history bounding,
 * F2 remap healing, click reveals, dialog settle races, selector waits and
 * event-stream termination. Behavioral assertions only: every test drives
 * the public BrowserEngine API (plus the documented test hooks) and asserts
 * observable state, returned effects, error codes or event sequences.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineEvent, EnginePage, EngineSession } from '@agentbrowser/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine } from './fake-engine.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Side door for the FakePage test hooks the public engine surface hides. */
type FakePageHandle = NonNullable<ReturnType<FakeEngine['getFakePage']>>;

/** Pages/session hooks that exist on the fake only, not on the engine contract. */
type SessionHooks = {
  openPopup(openerPageId: string): Promise<EnginePage>;
  getPageHandles(): EnginePage[];
};

/**
 * Consume a page's event stream while `run` executes, then end consumption by
 * closing the page (close is contractual stream termination). Deterministic:
 * queued events are drained before the iterator returns.
 */
async function collectEvents(
  page: EnginePage,
  run: () => Promise<void> | void
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  const consumer = (async () => {
    for await (const event of page.events()) {
      events.push(event);
    }
  })();
  await run();
  await page.close();
  await consumer;
  return events;
}

describe('FakeEngine edges', () => {
  let engine: FakeEngine;
  let session: EngineSession;
  let page: EnginePage;
  let fakePage: FakePageHandle;

  const revision = () => (fakePage as unknown as { revision: number }).revision;

  beforeEach(async () => {
    engine = new FakeEngine();
    session = await engine.createSession({});
    page = await session.newPage();
    fakePage = engine.getFakePage(session.id, page.id)!;
  });

  afterEach(async () => {
    await engine.close();
  });

  describe('test handles', () => {
    it('getFakePage returns undefined for an unknown session', () => {
      expect(engine.getFakePage('no-such-session', 'fake-page-0')).toBeUndefined();
    });

    it('getFakePage resolves composite ids that embed the engine page id', async () => {
      const composite = engine.getFakePage(session.id, `pg_1_${page.id}`);
      expect(composite).toBeDefined();
      expect(composite?.id).toBe(page.id);

      // A suffix that does not END WITH the embedded id must not match.
      expect(engine.getFakePage(session.id, `${page.id}-other`)).toBeUndefined();
      expect(engine.getFakePage(session.id, 'pg_1_no-such-page')).toBeUndefined();
      // Engine-internal session ids are enumerable for tests that need them.
      expect(engine.getSessionIds()).toEqual([session.id]);
    });

    it('getPageHandles exposes every live page of the session', async () => {
      const second = await session.newPage();
      const handles = (session as unknown as SessionHooks).getPageHandles();
      expect(handles.map((handle) => handle.id)).toEqual([page.id, second.id]);
    });
  });

  describe('popup emulation', () => {
    it('session.openPopup adds a page and announces page.created on the opener stream', async () => {
      await page.navigate({ url: 'https://opener.example.com' });
      const events = await collectEvents(page, async () => {
        const popup = await (session as unknown as SessionHooks).openPopup(page.id);
        expect(popup.id).not.toBe(page.id);
        expect(await session.pages()).toHaveLength(2);
      });
      const created = events.find((event) => event.type === 'page.created');
      expect(created).toBeDefined();
      expect(created?.data).toMatchObject({
        openerPageId: page.id,
        url: 'about:blank',
      });
    });

    it('session.openPopup refuses a closed session and an unknown opener', async () => {
      await expect(
        (session as unknown as SessionHooks).openPopup('fake-page-999')
      ).rejects.toThrow(/Unknown opener page/);

      await session.close();
      await expect(
        (session as unknown as SessionHooks).openPopup(page.id)
      ).rejects.toThrow('Session is closed');
    });

    it('page.openPopup delegates to the owning session', async () => {
      const events = await collectEvents(page, async () => {
        const popup = await (page as unknown as { openPopup(): Promise<EnginePage> }).openPopup();
        expect(popup.id).not.toBe(page.id);
      });
      expect(events.some((event) => event.type === 'page.created')).toBe(true);
    });

    it('page.openPopup refuses closed and crashed pages', async () => {
      await page.close();
      await expect(
        (page as unknown as { openPopup(): Promise<EnginePage> }).openPopup()
      ).rejects.toThrow('Page closed');

      const crashed = await session.newPage();
      engine.getFakePage(session.id, crashed.id)!.crash('renderer gone');
      await expect(
        (crashed as unknown as { openPopup(): Promise<EnginePage> }).openPopup()
      ).rejects.toThrow('Page closed');
    });
  });

  describe('live page accessors', () => {
    it('getUrl, getTitle and getCachedUrl report live state', async () => {
      expect(await page.getUrl!()).toBe('about:blank');
      expect(await page.getTitle!()).toBe('');
      expect(page.getCachedUrl!()).toBe('about:blank');

      await page.navigate({ url: 'https://example.com/a' });
      expect(await page.getUrl!()).toBe('https://example.com/a');
      expect(await page.getTitle!()).toBe('Page: https://example.com/a');
      expect(page.getCachedUrl!()).toBe('https://example.com/a');
    });

    it('getCachedUrl goes quiet for closed pages and getUrl refuses them', async () => {
      await page.close();
      expect(page.getCachedUrl!()).toBeUndefined();
      await expect(page.getUrl!()).rejects.toThrow('Page is closed');
    });

    it('crashed pages surface the crash message and drop the cached url', async () => {
      fakePage.crash('renderer gone: token-super-secret');
      expect(page.getCachedUrl!()).toBeUndefined();
      // The raw message reaches the engine boundary; redaction is upstream's job.
      await expect(page.getUrl!()).rejects.toThrow('renderer gone: token-super-secret');
    });

    it('setContent pins the HTML that observe reports', async () => {
      fakePage.setContent('<html><body><h1>pinned</h1></body></html>');
      const state = await page.observe({});
      expect(state.content).toBe('<html><body><h1>pinned</h1></body></html>');
    });
  });

  describe('dead-page guards', () => {
    it('navigate refuses a closed page and a crashed page', async () => {
      await page.close();
      await expect(page.navigate({ url: 'https://example.com/x' })).rejects.toThrow(
        'Page is closed'
      );

      const crashed = await session.newPage();
      engine.getFakePage(session.id, crashed.id)!.crash('renderer gone');
      await expect(crashed.navigate({ url: 'https://example.com/x' })).rejects.toThrow(
        'renderer gone'
      );
    });

    it('resolve refuses a closed page', async () => {
      await page.close();
      await expect(page.resolve({ ref: 'e1_1' })).rejects.toThrow('Page is closed');
    });

    it('act refuses a closed page', async () => {
      await page.close();
      await expect(page.act({ type: 'click', target: { ref: 'e1_1' } })).rejects.toThrow(
        'Page is closed'
      );
    });
  });

  describe('history bounding', () => {
    it('keeps only the last 50 entries; goBack bottoms out at the oldest survivor', async () => {
      for (let i = 1; i <= 55; i++) {
        await page.navigate({ url: `https://example.com/${i}` });
      }
      expect((await page.observe({})).url).toBe('https://example.com/55');

      for (let i = 0; i < 49; i++) {
        await page.act({ type: 'goBack' });
      }
      expect((await page.observe({})).url).toBe('https://example.com/6');

      // Oldest surviving entry: further goBack is a no-op (no revision bump).
      const before = revision();
      const effect = await page.act({ type: 'goBack' });
      expect(effect.newRevision).toBe(before);
      expect((await page.observe({})).url).toBe('https://example.com/6');
    });
  });

  describe('F2 remap healing', () => {
    it('heals a dead ref onto the single surviving role+name match', async () => {
      fakePage.setElements([{ ref: 'r1', role: 'button', name: 'Submit' }]);
      fakePage.setElements([{ ref: 'r2', role: 'button', name: 'Submit' }]);

      const before = revision();
      const effect = await page.act({ type: 'click', target: { ref: 'r1' }, remap: true });
      expect(effect.remap).toEqual({ from: 'r1', to: 'r2' });
      expect(effect.newRevision).toBe(before + 1);
    });

    it('refuses remap for a ref with no tombstone', async () => {
      await expect(
        page.act({ type: 'click', target: { ref: 'never-minted' }, remap: true })
      ).rejects.toThrow('Element not found');
    });

    it('refuses remap when zero or multiple role+name candidates survive', async () => {
      // Zero survivors carrying the dropped element's identity.
      fakePage.setElements([{ ref: 'r1', role: 'button', name: 'Gone' }]);
      fakePage.setElements([{ ref: 'r2', role: 'button', name: 'Other' }]);
      const before = revision();
      await expect(
        page.act({ type: 'click', target: { ref: 'r1' }, remap: true })
      ).rejects.toThrow(/Element not found: 0 remap candidate/);
      expect(revision()).toBe(before);

      // Two survivors: ambiguous, refuse rather than guess.
      fakePage.setElements([{ ref: 'r1', role: 'button', name: 'Dual' }]);
      fakePage.setElements([
        { ref: 'r2', role: 'button', name: 'Dual' },
        { ref: 'r3', role: 'button', name: 'Dual' },
      ]);
      await expect(
        page.act({ type: 'click', target: { ref: 'r1' }, remap: true })
      ).rejects.toThrow(/Element not found: 2 remap candidate/);
      expect(revision()).toBe(before);
    });
  });

  describe('click reveals', () => {
    it('appends revealed elements asynchronously after a click on the named element', async () => {
      await page.navigate({ url: 'https://example.com/form' });
      fakePage.revealAfterClick(
        'Element 1',
        [
          { ref: 'pw-seeded', role: 'textbox', name: 'Password' },
          { role: 'button', name: 'Next' }, // no ref: one is minted from the live revision
        ],
        30
      );

      // The reveal is matched by NAME: resolve the live ref through observe
      // (refs are re-minted per revision, so 'e1_1' would already be stale).
      const before = await page.observe({});
      const openerRef = before.elements.find((element) => element.name === 'Element 1')?.ref;
      expect(openerRef).toBeDefined();
      await page.act({ type: 'click', target: { ref: openerRef! } });

      // Deliberately async: nothing revealed yet.
      const early = await page.observe({});
      expect(early.elements.some((element) => element.name === 'Password')).toBe(false);

      await sleep(100);
      const later = await page.observe({});
      const password = later.elements.find((element) => element.name === 'Password');
      expect(password?.role).toBe('textbox');
      expect(password?.ref).toBe('pw-seeded');
      const next = later.elements.find((element) => element.name === 'Next');
      expect(next?.ref).toMatch(/^e\d+_\d+$/);
    });
  });

  describe('select', () => {
    it('stores the first selected value and bumps the revision', async () => {
      fakePage.setElements([{ ref: 'cb1', role: 'combobox', name: 'Color' }]);
      const before = revision();

      const effect = await page.act({
        type: 'select',
        target: { ref: 'cb1' },
        values: ['blue', 'red'],
      });
      expect(effect.newRevision).toBe(before + 1);
      const state = await page.observe({});
      expect(state.elements.find((element) => element.ref === 'cb1')?.value).toBe('blue');

      // Selecting without values is still a mutating action (revision bump),
      // but leaves the stored value alone.
      const effectEmpty = await page.act({ type: 'select', target: { ref: 'cb1' } });
      expect(effectEmpty.newRevision).toBe(before + 2);
      const stateEmpty = await page.observe({});
      expect(stateEmpty.elements.find((element) => element.ref === 'cb1')?.value).toBe('blue');
    });
  });

  describe('upload validation', () => {
    it('refuses uploads with no paths before touching the page', async () => {
      const before = revision();
      await expect(page.act({ type: 'upload', paths: [] })).rejects.toThrow(
        'upload requires at least one path'
      );
      await expect(page.act({ type: 'upload' })).rejects.toThrow(
        'upload requires at least one path'
      );
      expect(revision()).toBe(before);
    });

    it('reports id, accept and multiple in the ambiguity detail', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-upload-'));
      const file = path.join(dir, 'resume.pdf');
      fs.writeFileSync(file, '%PDF-fake');
      try {
        fakePage.seedElements([
          {
            ref: 'f1',
            role: 'fileinput',
            name: 'doc',
            attributes: { id: 'doc-input', accept: '.pdf', multiple: 'true' },
          },
          { ref: 'f2', role: 'fileinput', name: '', attributes: {} },
        ]);

        await expect(page.act({ type: 'upload', paths: [file] })).rejects.toMatchObject({
          code: 'TARGET_AMBIGUOUS',
          details: {
            count: 2,
            inputs: [
              {
                index: 0,
                name: 'doc',
                id: 'doc-input',
                accept: '.pdf',
                multiple: true,
                visible: true,
              },
              { index: 1, multiple: false, visible: true },
            ],
            advice: expect.stringContaining('fileInputs'),
          },
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('act-driven navigation', () => {
    it('act({type:"navigate"}) performs a real navigation', async () => {
      const effect = await page.act({ type: 'navigate', url: 'https://example.com/via-act' });
      expect(effect.result).toEqual({ success: true });
      expect(effect.newRevision).toBe(effect.oldRevision + 1);

      const state = await page.observe({});
      expect(state.url).toBe('https://example.com/via-act');
      expect(state.title).toBe('Page: https://example.com/via-act');
    });
  });

  describe('vestigial extract seam', () => {
    it('extract returns the fixed placeholder result', async () => {
      expect(await page.extract({ format: 'json' })).toEqual({
        data: { extracted: true },
        evidence: [],
      });
    });
  });

  describe('event stream termination', () => {
    it('endStream flushes queued events then ends the stream without page.destroyed', async () => {
      const events: EngineEvent[] = [];
      const consumer = (async () => {
        for await (const event of page.events()) {
          events.push(event);
        }
      })();

      fakePage.emitEvent('page.loaded');
      await sleep(20); // consumer drains the event, then parks in the waiter queue
      fakePage.endStream();
      await consumer;

      expect(events.map((event) => event.type)).toEqual(['page.loaded']);
    });

    it('closing a page with a held dialog drops it silently: no auto-settle, no dialog.closed', async () => {
      const handled: Array<Record<string, unknown>> = [];
      fakePage.onDialogHandled((record) => handled.push(record));

      const events = await collectEvents(page, () => {
        fakePage.emitDialog({ type: 'alert', message: 'held' });
      });
      await sleep(150); // well past the auto-settle grace: nothing may fire

      expect(handled).toHaveLength(0);
      expect(events.some((event) => event.type === 'dialog.opened')).toBe(true);
      expect(events.some((event) => event.type === 'dialog.closed')).toBe(false);
      expect(events.some((event) => event.type === 'page.destroyed')).toBe(true);
    });

    it('closing the page ends a parked events() consumer', async () => {
      const events: EngineEvent[] = [];
      const consumer = (async () => {
        for await (const event of page.events()) {
          events.push(event);
        }
      })();
      await sleep(20); // consumer parked waiting for events
      await page.close();
      await consumer; // resolves because close wakes the waiters

      expect(events.map((event) => event.type)).toEqual(['page.destroyed']);
    });

    it('closing a crashed page still terminates a parked consumer, with no destroyed event', async () => {
      // A crashed page suppresses the page.destroyed announcement on close,
      // so close must wake parked stream consumers directly.
      fakePage.crash('renderer gone');
      const events: EngineEvent[] = [];
      const consumer = (async () => {
        for await (const event of page.events()) {
          events.push(event);
        }
      })();
      await sleep(20); // drained the queued page.crashed event, then parked
      await page.close();
      await consumer;

      expect(events.map((event) => event.type)).toEqual(['page.crashed']);
    });

    it('a stale dialog timer after an earlier auto-settle is a no-op', async () => {
      // Three held dialogs: the first timer settles the newest dialog and
      // clears ITS timer, but the middle dialog's timer still fires later and
      // must settle nothing (no duplicate dialog.closed).
      const events = await collectEvents(page, async () => {
        fakePage.emitDialog({ type: 'alert', message: 'first' });
        fakePage.emitDialog({ type: 'alert', message: 'second' });
        fakePage.emitDialog({ type: 'alert', message: 'third' });
        await sleep(200);
      });

      const opened = events.filter((event) => event.type === 'dialog.opened');
      const closed = events.filter((event) => event.type === 'dialog.closed');
      expect(opened).toHaveLength(3);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.data).toMatchObject({ reason: 'auto', message: 'third' });
    });
  });

  describe('selector waits', () => {
    it('waitForSelector resolves immediately and after a delayed reveal', async () => {
      fakePage.revealSelector('#now');
      await page.waitForSelector!('#now', { timeoutMs: 500 });

      fakePage.revealSelector('#soon', 50);
      const start = Date.now();
      await page.waitForSelector!('#soon', { timeoutMs: 2000 });
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });

    it('waitForSelector times out with the contracted message', async () => {
      await expect(page.waitForSelector!('#never', { timeoutMs: 60 })).rejects.toThrow(
        "Timeout 60ms exceeded waiting for selector '#never'"
      );
    });
  });

  describe('formControls include token', () => {
    it('mint role:"control" elements only when the caller asks for them', async () => {
      fakePage.seedElements([
        { ref: 'c1', role: 'control', name: 'scan-result', value: '{"ok":true}' },
        { ref: 'b1', role: 'button', name: 'Real button' },
      ]);

      const plain = await page.observe({});
      expect(plain.elements.some((element) => element.role === 'control')).toBe(false);
      expect(plain.elements.some((element) => element.name === 'Real button')).toBe(true);

      const scanned = await page.observe({ include: ['formControls'] });
      expect(scanned.elements.find((element) => element.ref === 'c1')?.value).toBe('{"ok":true}');
    });
  });
});

describe('FakeEngine package surface', () => {
  it('the barrel re-exports the whole public testkit surface', async () => {
    const testkit = await import('./index.js');
    expect(testkit.FakeEngine).toBe(FakeEngine);
    expect(typeof testkit.runEngineContractSuite).toBe('function');
    expect(typeof testkit.startVersionedApp).toBe('function');
    expect(typeof testkit.qualifyApplicationParity).toBe('function');
  });

  it(
    'refuses to qualify the non-browsing FakeEngine: the fixture is never fetched',
    async () => {
      const { qualifyApplicationParity } = await import('./application-parity.js');
      const engine = new FakeEngine();
      try {
        // FakeEngine.navigate fabricates elements without fetching the URL, so
        // the parity harness must fail closed at its state deadline, never
        // pass, and still tear down its session and fixture server.
        await expect(qualifyApplicationParity(engine)).rejects.toThrow(
          /Application fixture did not reach expected state/
        );
      } finally {
        await engine.close();
      }
    },
    20000
  );
});
