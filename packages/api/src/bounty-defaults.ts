import type { RequestPolicy } from '@agentbrowser/engine';
import { NetworkPolicyError } from '@agentbrowser/policy';

interface PresetInput {
  mode?: 'bounty';
  cdpAttach?: boolean;
  headless?: boolean;
  ttlMs?: number;
  idleTimeoutMs?: number;
  scope?: { rateLimit?: { requests: number; perSeconds: number } };
}

/** T10 B1. Explicit requests win over deployment defaults, then the preset. */
export function applyBountyDefaults<T extends PresetInput>(
  input: T,
  defaults: { mode?: 'bounty'; ttlMs?: number; idleTimeoutMs?: number } = {}
): T {
  if ((input.mode ?? defaults.mode) !== 'bounty') return input;
  return {
    ...input,
    mode: 'bounty',
    ttlMs: input.ttlMs ?? defaults.ttlMs ?? 14_400_000,
    idleTimeoutMs: input.idleTimeoutMs ?? defaults.idleTimeoutMs ?? 3_600_000,
    // CDP attachment is explicitly unenforced; never imply a launch override or rate cap.
    ...(input.cdpAttach ? {} : { headless: input.headless ?? false }),
    ...(input.scope
      ? {
          scope: {
            ...input.scope,
            rateLimit: input.scope.rateLimit ?? { requests: 5, perSeconds: 1 },
          },
        }
      : {}),
  };
}

/** Unscoped contained exploration is paced too. Every base gate remains bound to its owner. */
export function bountyPacing(base: RequestPolicy): { policy: RequestPolicy; stop(): void } {
  let admitted: number[] = [];
  let queue = Promise.resolve();
  const abort = new AbortController();
  const refuse = () =>
    new NetworkPolicyError('POLICY_DENIED', 'Bounty pacing stopped or queue exhausted', false, {
      rule: 'floor.bounty.rateLimit',
    });
  const checkRequest: RequestPolicy['checkRequest'] = async (request) => {
    await base.checkRequest(request);
    const enqueued = Date.now();
    const turn = queue.then(async () => {
      for (;;) {
        if (abort.signal.aborted) throw refuse();
        const now = Date.now();
        admitted = admitted.filter((at) => at > now - 1000);
        if (admitted.length < 5) {
          admitted.push(now);
          return;
        }
        const wait = Math.max(1, (admitted[0] ?? now) + 1000 - now);
        if (now - enqueued + wait > 15000) throw refuse();
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            abort.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, wait);
          timer.unref?.();
          abort.signal.addEventListener('abort', done, { once: true });
        });
      }
    });
    queue = turn.catch(() => {});
    await turn;
  };
  return {
    policy: new Proxy(base, {
      get(target, property) {
        if (property === 'checkRequest') return checkRequest;
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    stop: () => abort.abort(),
  };
}
