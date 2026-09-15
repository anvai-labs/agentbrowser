# Native Firefox BiDi (experimental)

Independent, trusted-local browser adapter. The guarded REST server cannot use
this adapter yet: sessions carrying a request policy are refused before launch.
There is no automatic engine switch after an uncertain write.

```ts
import { FirefoxBiDiEngine } from '@agentbrowser/engine-firefox';
const engine = new FirefoxBiDiEngine({ executablePath: '/absolute/path/to/firefox' });
try {
  const page = await (await engine.createSession({})).newPage();
  await page.navigate({ url: 'https://example.com' });
  const state = await page.observe({ mode: 'interactive' });
  // state.degradedReason === 'dom-semantic-subset'; native AX, frames and shadow DOM are unqualified.
} finally {
  await engine.close();
}
```

From the repository root, run `pnpm firefox:install`, then `pnpm test:firefox`
and `pnpm test:firefox-independence`. An explicit
`AGENTBROWSER_FIREFOX_EXECUTABLE` overrides the cached browser for local probes.
The qualification commands fail when the executable is missing. Production
installs do not download any browser automatically. Node 22.12 or newer is
required by the pinned Puppeteer dependency.

Observe and act through fresh refs. Screenshot capture requires explicit
`maskSensitive: false`. This adapter is not an egress containment mechanism.
