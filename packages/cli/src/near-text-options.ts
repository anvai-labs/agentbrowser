import { NEAR_TEXT_MAX_LENGTH, type NearTextTarget } from '@agentbrowser/protocol';
import { UsageError } from '@agentbrowser/sdk-typescript';
import type { Command } from 'commander';

export interface NearTextOptions {
  nearText?: string;
  row?: boolean;
}

/**
 * TD-BROWSER-18 gap 6: the geometric escape hatch for unlabeled controls.
 * Mirrors withCoordinateOptions: the CLI accepts a ref, an approved
 * coordinate point, or a near-text needle — exactly one.
 */
export function withNearTextOptions(command: Command): Command {
  return command
    .option(
      '--near-text <text>',
      `target the interactive element nearest this visible text (case-insensitive, at most ${NEAR_TEXT_MAX_LENGTH} chars)`
    )
    .option(
      '--row',
      "restrict --near-text to the text's visual row and prefer the trailing element"
    );
}

/**
 * Build the near-text target from parsed options, or undefined when the
 * flags are absent. --row without --near-text is a caller mistake, not a
 * default.
 */
export function nearTextTarget(options: NearTextOptions): NearTextTarget | undefined {
  if (options.nearText === undefined) {
    if (options.row === true) throw new UsageError('--row requires --near-text');
    return undefined;
  }
  if (options.nearText.length === 0 || options.nearText.length > NEAR_TEXT_MAX_LENGTH) {
    throw new UsageError(
      `--near-text requires a non-empty needle of at most ${NEAR_TEXT_MAX_LENGTH} characters`
    );
  }
  return options.row === true
    ? { nearText: options.nearText, row: true }
    : { nearText: options.nearText };
}

/**
 * Exactly one targeting form per action: a positional ref, --at, or
 * --near-text. Named violations keep the caller pointed at the fix.
 */
export function assertSingleTargetForm({
  ref,
  at,
  near,
}: {
  ref?: string | undefined;
  at?: unknown;
  near?: NearTextTarget | undefined;
}): void {
  const present = [ref !== undefined, at !== undefined, near !== undefined].filter(Boolean);
  if (present.length > 1) {
    throw new UsageError('Choose one target form: an element ref, --at, or --near-text');
  }
}
