import { createRequire } from 'node:module';
import { launch } from 'puppeteer-core';

import { installPublicEgressPage } from './public-egress-request.mjs';

/** Original page-scoped probe candidate, kept separate from the session-wide candidate. */
export async function launchPublicEgressBrowser({ executablePath, target, deny, errors, intercepted }) {
  const browser = await launch({ browser: 'firefox', protocol: 'webDriverBiDi', executablePath, headless: true, args: ['--no-remote'] });
  const installed = new WeakMap();
  const installs = new Set();
  const install = page => {
    if (installed.has(page)) return installed.get(page);
    const pending = installPublicEgressPage(page, { target, deny, errors, intercepted });
    installed.set(page, pending); installs.add(pending);
    pending.then(() => installs.delete(pending), () => installs.delete(pending));
    return pending;
  };
  const onTarget = target => {
    if (target.type() !== 'page') return;
    // Firefox frame targets also report type=page. Use canonical top-level pages.
    const pending = browser.pages().then(pages => Promise.all(pages.map(install)));
    installs.add(pending);
    pending.then(() => installs.delete(pending), error => {
      installs.delete(pending); errors.push({ phase: 'popup-install', message: error.message });
    });
  };
  browser.on('targetcreated', onTarget);
  return {
    driver: createRequire(import.meta.url)('puppeteer-core/package.json').version,
    version: () => browser.version(),
    async newPage() {
      const page = await browser.newPage(); await install(page); page.setDefaultTimeout(5000); return page;
    },
    async close() {
      browser.off('targetcreated', onTarget);
      try { await browser.close(); } finally { await Promise.allSettled([...installs]); }
    },
  };
}
