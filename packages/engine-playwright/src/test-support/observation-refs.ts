import type { EnginePage } from '@agentbrowser/engine';

/**
 * Fresh observation per action: any mutation invalidates the previous refs.
 * Shared by the action suites so each mutation step re-resolves by role+name
 * exactly one way.
 */
export async function refOf(page: EnginePage, role: string, name: string): Promise<string> {
  const state = await page.observe({});
  const element = state.elements.find((el) => el.role === role && el.name === name);
  if (!element?.ref) throw new Error(`missing observed ${role} "${name}"`);
  return element.ref;
}
