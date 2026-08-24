/**
 * Observation Normalization
 *
 * Converts raw browser engine state into engine-neutral semantic observations
 * with proper element reference management, revision tracking, and semantic prioritization.
 */

import type { RawPageState, RawElement } from '@agentbrowser/engine';
import type { ObservationRequest, ObservationMode, PageElement, PageState } from '@agentbrowser/protocol';

const INTERACTIVE_ROLES = new Set<string>([
  'button',
  'link',
  'textbox',
  'searchbox',
  'textarea',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'menu',
  'menubar',
  'tab',
  'tablist',
]);

export interface NormalizationOptions {
  mode?: ObservationMode;
  revision: number;
  maxElements?: number;
  maxBytes?: number;
  sessionId?: string;
  pageId?: string;
  sinceRevision?: number;
}

/**
 * ObservationNormalizer converts raw engine state into semantic observations
 */
export class ObservationNormalizer {
  private elementCounter = 0;

  /**
   * Normalize raw page state into semantic observation
   */
  normalize(rawState: RawPageState, options: NormalizationOptions): PageState {
    const mode = options.mode || 'interactive';
    const maxElements = options.maxElements || 300;
    const sessionId = options.sessionId || 'ses_default';
    const pageId = options.pageId || 'pg_default';

    // Process elements based on mode
    const elements = this.processElements(rawState.elements, mode, options.revision);

    // Apply truncation if needed
    const { truncated, prioritizedElements } = this.applyTruncation(
      elements,
      maxElements,
      rawState
    );

    // Generate page summary
    const summary = this.generateSummary(prioritizedElements, rawState);

    // Build base observation
    const observation: PageState = {
      sessionId,
      pageId,
      revision: options.revision,
      url: rawState.url,
      title: rawState.title,
      status: rawState.status,
      summary,
      elements: prioritizedElements,
      truncated,
      untrustedContent: true, // All web content is untrusted
    };

    // Add focusedRef only if there is a focused element
    const focusedRef = this.getFocusedRef(prioritizedElements);
    if (focusedRef !== undefined) {
      observation.focusedRef = focusedRef;
    }

    return observation;
  }

  /**
   * Process elements based on observation mode
   */
  private processElements(rawElements: RawElement[], mode: ObservationMode, revision: number): PageElement[] {
    return rawElements.map((rawEl, index) => {
      const element: PageElement = {
        ref: this.generateRef(revision, index),
        role: rawEl.role || 'unknown',
        visible: rawEl.visible !== false,
        enabled: rawEl.enabled !== false,
      };

      // Add optional properties if present
      if (rawEl.name !== undefined) {
        element.name = rawEl.name;
      }

      if (rawEl.value !== undefined) {
        element.value = rawEl.value;
      }

      if (rawEl.required !== undefined) {
        element.required = rawEl.required;
      }

      if (rawEl.focused !== undefined) {
        element.focused = rawEl.focused;
      }

      // Add risk classification if present
      if (rawEl.risk !== undefined) {
        element.risk = rawEl.risk;
      }

      return element;
    });
  }

  /**
   * Apply truncation with prioritization
   */
  private applyTruncation(
    elements: PageElement[],
    maxElements: number,
    rawState: RawPageState
  ): { truncated: boolean; prioritizedElements: PageElement[] } {
    if (elements.length <= maxElements) {
      return { truncated: false, prioritizedElements: elements };
    }

    // Prioritize elements: focused > interactive > content
    const prioritized = this.prioritizeElements(elements);

    return {
      truncated: true,
      prioritizedElements: prioritized.slice(0, maxElements),
    };
  }

  /**
   * Prioritize elements for truncation
   */
  private prioritizeElements(elements: PageElement[]): PageElement[] {
    // Sort by priority:
    // 1. Focused elements first
    // 2. Interactive elements (button, link, textbox, etc.)
    // 3. Content elements

    return [...elements].sort((a, b) => {
      // Focused elements always first
      if (a.focused && !b.focused) return -1;
      if (!a.focused && b.focused) return 1;

      // Interactive elements next
      const aInteractive = this.isInteractive(a);
      const bInteractive = this.isInteractive(b);

      if (aInteractive && !bInteractive) return -1;
      if (!aInteractive && bInteractive) return 1;

      // Maintain relative order for same priority
      return 0;
    });
  }

  /**
   * Check if element is interactive
   */
  private isInteractive(element: PageElement): boolean {
    return INTERACTIVE_ROLES.has(element.role);
  }

  /**
   * Generate stable element reference
   */
  private generateRef(revision: number, index: number): string {
    return `e${revision}_${index}`;
  }

  /**
   * Get focused element reference
   */
  private getFocusedRef(elements: PageElement[]): string | undefined {
    const focused = elements.find((el) => el.focused);
    return focused?.ref;
  }

  /**
   * Generate page summary
   */
  private generateSummary(elements: PageElement[], rawState: RawPageState): string {
    let buttonCount = 0;
    let inputCount = 0;
    let linkCount = 0;

    for (const element of elements) {
      switch (element.role) {
        case 'button':
          buttonCount++;
          break;
        case 'textbox':
        case 'searchbox':
          inputCount++;
          break;
        case 'link':
          linkCount++;
          break;
      }
    }

    const parts: string[] = [];

    if (buttonCount > 0) {
      parts.push(`${buttonCount} button${buttonCount > 1 ? 's' : ''}`);
    }
    if (inputCount > 0) {
      parts.push(`${inputCount} input${inputCount > 1 ? 's' : ''}`);
    }
    if (linkCount > 0) {
      parts.push(`${linkCount} link${linkCount > 1 ? 's' : ''}`);
    }

    if (parts.length === 0) {
      return `Page with ${elements.length} elements`;
    }

    return `Page with ${parts.join(', ')}`;
  }

  /**
   * Reset element counter (for testing)
   */
  resetCounter(): void {
    this.elementCounter = 0;
  }
}
