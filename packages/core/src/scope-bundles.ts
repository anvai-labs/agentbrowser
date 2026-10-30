import type { ScopeAssetHost } from './scope-assets.js';

/** Optional static-host suggestions, not live program policy or authorization. */
const categories: Record<string, ScopeAssetHost[]> = {
  consent: [
    { host: 'cdn.cookielaw.org', class: 'asset', category: 'consent' },
    { host: 'cdn.onetrust.com', class: 'asset', category: 'consent' },
  ],
  captcha: [
    { host: '.hcaptcha.com', class: 'asset', category: 'captcha' },
    { host: '.hcaptcha.net', class: 'asset', category: 'captcha' },
    { host: 'www.recaptcha.net', class: 'asset', category: 'captcha' },
  ],
  assets: [
    { host: 'images.ctfassets.net', class: 'asset', category: 'asset' },
    { host: 'videos.ctfassets.net', class: 'asset', category: 'asset' },
    { host: '.cdn4dd.com', class: 'asset', category: 'asset' },
  ],
  sso: [
    { host: 'accounts.google.com', class: 'asset', category: 'sso' },
    { host: 'accounts.gstatic.com', class: 'asset', category: 'sso' },
    { host: 'ssl.gstatic.com', class: 'asset', category: 'sso' },
  ],
};
const classes: Record<string, string[]> = {
  retail: ['consent', 'captcha', 'assets'],
  saas: ['consent', 'assets', 'sso'],
};

export function scopeBundleHosts(names: string[]): ScopeAssetHost[] {
  if (names.length > 6) throw new Error('Select at most six asset bundles');
  const selected = new Map<string, ScopeAssetHost>();
  for (const name of names) {
    const groups = Object.hasOwn(classes, name)
      ? classes[name]
      : Object.hasOwn(categories, name)
        ? [name]
        : undefined;
    if (!groups)
      throw new Error('Unknown asset bundle; choose retail, saas, consent, captcha, assets or sso');
    for (const group of groups)
      for (const entry of categories[group] ?? []) selected.set(entry.host, { ...entry });
  }
  return [...selected.values()];
}
