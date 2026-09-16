import { ControlError } from '@agentbrowser/core';

/** Serialize once, bounding output before allocation; never invoke data accessors. */
export function canonicalJson(value: unknown): string {
  let bytes = 65536;
  let nodes = 4096;
  const chunks: string[] = [];
  const charge = (count: number) => {
    bytes -= count;
    if (bytes < 0) throw new ControlError('INVALID_REQUEST', 'Application input is too large');
  };
  const append = (text: string) => {
    charge(text.length); // Structural and numeric tokens are ASCII.
    chunks.push(text);
  };
  const string = (text: string) => {
    charge(2); // Quotes; every UTF-16 unit requires at least one JSON UTF-8 byte.
    if (text.length > bytes)
      throw new ControlError('INVALID_REQUEST', 'Application input is too large');
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        charge(2);
      else if (code < 32) charge(6);
      else if (code < 128) charge(1);
      else if (code < 2048) charge(2);
      else if (code >= 0xd800 && code <= 0xdfff) {
        const next = text.charCodeAt(i + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          charge(4);
          i++;
        } else charge(6); // JSON.stringify escapes lone surrogates.
      } else charge(3);
    }
    chunks.push(JSON.stringify(text));
  };
  const data = (object: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      throw new ControlError('INVALID_REQUEST', 'Application input must contain own JSON data');
    return descriptor.value;
  };
  const visit = (item: unknown, depth: number): void => {
    if (--nodes < 0) throw new ControlError('INVALID_REQUEST', 'Application input is too large');
    if (depth > 16) throw new ControlError('INVALID_REQUEST', 'Application input is too deep');
    if (typeof item === 'string') {
      string(item);
      return;
    }
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      append(JSON.stringify(item));
      return;
    }
    if (Array.isArray(item)) {
      if (item.length > nodes)
        throw new ControlError('INVALID_REQUEST', 'Application input is too large');
      append('[');
      for (let i = 0; i < item.length; i++) {
        if (i) append(',');
        visit(data(item, String(i)), depth + 1);
      }
      append(']');
      return;
    }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      const keys = Object.keys(item);
      if (keys.length * 2 > nodes)
        throw new ControlError('INVALID_REQUEST', 'Application input is too large');
      append('{');
      for (const [index, key] of keys.sort().entries()) {
        if (index) append(',');
        visit(key, depth + 1);
        append(':');
        visit(data(item, key), depth + 1);
      }
      append('}');
      return;
    }
    throw new ControlError('INVALID_REQUEST', 'Application input must be JSON');
  };
  visit(value, 0);
  return chunks.join('');
}
