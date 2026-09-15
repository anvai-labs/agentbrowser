import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Browser, computeExecutablePath } from '@puppeteer/browsers';

export const buildId = 'stable_155.0.1';
export const cacheDir = fileURLToPath(new URL('../../../.cache/firefox', import.meta.url));
export const browser = Browser.FIREFOX;
export function firefoxExecutable() {
  const path = process.env.AGENTBROWSER_FIREFOX_EXECUTABLE || computeExecutablePath({ browser, buildId, cacheDir });
  if (!existsSync(path)) throw new Error(`Firefox executable missing: ${path}. Run pnpm firefox:install or set AGENTBROWSER_FIREFOX_EXECUTABLE. No browser fallback is allowed.`);
  return path;
}
