/**
 * Contract-sync gates: the spec manifest, the protocol capability vocabulary
 * and the delegated route table are three views of one vocabulary. They were
 * kept aligned by hand; these tests make drift a CI failure (the manifest
 * is checkout tooling input, the protocol tuple is the runtime source).
 */

import { readFileSync } from 'node:fs';
import { AGENT_MODE_IDS } from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';

interface SpecManifest {
  modes: Record<string, unknown>;
  tasks: Record<string, { modes?: string[] }>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../../docs/spec/manifest.json', import.meta.url), 'utf8')
) as SpecManifest;

describe('contract vocabulary sync', () => {
  it('keeps the spec manifest modes identical to the protocol mode registry', () => {
    // T1's context loader routes by the manifest; REST admission routes by
    // the protocol registry. One list, two readers - they must never
    // diverge (order included, so additions are a conscious shared edit).
    expect(Object.keys(manifest.modes)).toEqual([...AGENT_MODE_IDS]);
  });

  it('keeps manifest task modes inside the protocol vocabulary', () => {
    for (const task of Object.values(manifest.tasks)) {
      for (const mode of task.modes ?? []) {
        expect(AGENT_MODE_IDS).toContain(mode);
      }
    }
  });
  // Delegated-route capability vocabulary membership is enforced by the
  // compiler: route registration meta types `capability` as AgentCapability
  // (see the `on` helper in server.ts), and route-contract.test.ts pins the
  // per-route values.
});
