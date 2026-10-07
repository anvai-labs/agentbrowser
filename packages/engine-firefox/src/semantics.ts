import type { RawElement } from '@agentbrowser/engine';

/** Runs in the page. A deliberately bounded DOM interpretation, not an AX tree. */
export function describeElement(element: Element): {
  description: Omit<RawElement, 'ref'>;
  /** Private binding evidence, never returned in an observation. */
  evidence: string;
} | null {
  if (!element.isConnected || element.ownerDocument !== document) return null;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const tag = element.tagName.toLowerCase();
  const input = element as HTMLInputElement;
  const explicit = element.getAttribute('role')?.split(/\s+/)[0];
  const roles: Record<string, string> = {
    a: 'link',
    button: 'button',
    textarea: 'textbox',
    select: 'combobox',
    summary: 'button',
  };
  const role =
    explicit ||
    (tag === 'input'
      ? ({
          checkbox: 'checkbox',
          radio: 'radio',
          submit: 'button',
          button: 'button',
          range: 'slider',
          number: 'spinbutton',
        }[input.type] ?? 'textbox')
      : (roles[tag] ?? 'generic'));
  const labelled = (element.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
  const labels = input.labels
    ? Array.from(input.labels, (label) => {
        const copy = label.cloneNode(true) as Element;
        for (const control of copy.querySelectorAll('input,select,textarea,button'))
          control.remove();
        return copy.textContent ?? '';
      }).join(' ')
    : '';
  const name = (
    labelled ||
    element.getAttribute('aria-label') ||
    labels ||
    (['button', 'submit'].includes(input.type) ? input.value : '') ||
    (tag === 'input' || tag === 'textarea' ? '' : element.textContent) ||
    element.getAttribute('placeholder') ||
    ''
  )
    .trim()
    .replace(/\s+/g, ' ');
  // Same sensitivity policy as the Playwright engine (TD-BROWSER-13): a
  // marked node (explicit sensitive fill), a password/hidden input, or a
  // credential-autocomplete field never publishes its value; valueRedacted
  // marks the withholding. Type and autocomplete gate without any registry;
  // the marks WeakSet only carries explicit sensitive-fill history.
  const sensitiveMarks = (globalThis as { __agentbrowserSensitiveInputs?: WeakSet<object> })
    .__agentbrowserSensitiveInputs;
  const credentialAutocomplete =
    /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)(\s|$)/.test(
      (element.getAttribute('autocomplete') ?? '').toLowerCase()
    );
  const sensitiveInputType = input.type === 'password' || input.type === 'hidden';
  const sensitive =
    sensitiveMarks?.has(element) === true || sensitiveInputType || credentialAutocomplete;
  const description: Omit<RawElement, 'ref'> = {
    role,
    name: name.slice(0, 500),
    ...('value' in element && !sensitive ? { value: String(input.value).slice(0, 2000) } : {}),
    ...(sensitive ? { valueRedacted: true } : {}),
    ...(['checkbox', 'radio'].includes(role) ? { checked: input.checked } : {}),
    ...(tag === 'a'
      ? {
          href: (element as HTMLAnchorElement).href.slice(0, 2048),
          hrefTruncated: (element as HTMLAnchorElement).href.length > 2048,
        }
      : {}),
    visible:
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      !element.closest('[hidden],[inert]'),
    enabled: !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true',
    focused: document.activeElement === element,
    required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
  };
  return {
    description,
    evidence: JSON.stringify([
      name,
      element.outerHTML,
      'value' in element ? input.value : null,
      'href' in element ? (element as HTMLAnchorElement).href : null,
    ]),
  };
}

export function fingerprint(
  element: Pick<RawElement, 'role' | 'name' | 'visible' | 'enabled' | 'value'>
): string {
  return [
    element.role,
    element.name || '',
    `visible_${element.visible}`,
    `enabled_${element.enabled}`,
    element.value ? `value_${element.value}` : '',
  ]
    .filter(Boolean)
    .join('_');
}
