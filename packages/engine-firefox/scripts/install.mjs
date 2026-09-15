import { appendFileSync } from 'node:fs';
import { install } from '@puppeteer/browsers';
import { browser, buildId, cacheDir } from './browser-config.mjs';

const installed = await install({ browser, buildId, cacheDir });
console.log(installed.executablePath);
if (process.argv.includes('--github-env')) {
  if (!process.env.GITHUB_ENV || /[\r\n]/.test(installed.executablePath)) throw new Error('Invalid GitHub environment destination/path');
  appendFileSync(process.env.GITHUB_ENV, `AGENTBROWSER_FIREFOX_EXECUTABLE=${installed.executablePath}\n`);
}
