import type { EngineEvent } from '@agentbrowser/engine';
import { type EventReplaySelector, isScopeDenialCode } from '@agentbrowser/protocol';
import { RE2JS } from 're2js';

export const EVENT_REPLAY_MAX_PATTERN_PROGRAM = 1024;

export class EventReplayPatternError extends Error {
  constructor() {
    super('Invalid event URL pattern.');
    this.name = 'EventReplayPatternError';
  }
}

/** Display/search the same HTTP location; queries, fragments and credentials are omitted. */
export function eventReplayUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}${url.pathname}`
      : undefined;
  } catch {
    return undefined;
  }
}

function isDenied(event: EngineEvent): boolean {
  if (event.type === 'scope.denied') return isScopeDenialCode(event.data?.scope);
  return (
    event.type === 'request.failed' &&
    (event.data?.blocked === true || isScopeDenialCode(event.data?.scope))
  );
}

function terminalStatus(event: EngineEvent): number | undefined {
  const status = event.data?.status;
  return event.type === 'request.finished' &&
    event.data?.passthrough !== true &&
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

/** Compile once per admitted read; input must already be owner-published data. */
export function compileEventReplayFilter(
  selector: EventReplaySelector
): (event: EngineEvent) => boolean {
  let pattern: RE2JS | undefined;
  if (selector.urlRegex !== undefined) {
    try {
      if (Buffer.byteLength(selector.urlRegex, 'utf8') > 256) throw new EventReplayPatternError();
      pattern = RE2JS.compile(selector.urlRegex);
      if (pattern.programSize() > EVENT_REPLAY_MAX_PATTERN_PROGRAM)
        throw new EventReplayPatternError();
    } catch {
      throw new EventReplayPatternError();
    }
  }
  const requestFilter = ['urlRegex', 'method', 'statusClass', 'failedOnly'].some((key) =>
    Object.hasOwn(selector, key)
  );
  return (event) => {
    if (selector.type !== undefined && event.type !== selector.type) return false;
    if (requestFilter && selector.type === undefined && !event.type.startsWith('request.'))
      return false;
    if (selector.method !== undefined && event.data?.method !== selector.method) return false;
    if (pattern !== undefined) {
      const url = eventReplayUrl(event.data?.url);
      if (url === undefined || !pattern.test(url)) return false;
    }
    const status = terminalStatus(event);
    if (selector.statusClass === 'denied') {
      if (!isDenied(event)) return false;
    } else if (selector.statusClass !== undefined) {
      const expected = Number(selector.statusClass[0]);
      if (status === undefined || Math.floor(status / 100) !== expected) return false;
    }
    if (
      selector.failedOnly === true &&
      event.type !== 'request.failed' &&
      !isDenied(event) &&
      !(status !== undefined && status >= 400)
    )
      return false;
    return true;
  };
}
