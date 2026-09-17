import { describe, expect, it } from 'vitest';
import { parseOperationReplay } from './control.js';

const replay = () => ({
  replay: true,
  operation: {
    operationId: 'outcome-once',
    epoch: 2,
    status: 'completed',
    dispatched: true,
  },
});

describe('operation replay contract', () => {
  it('returns one detached strict operation record', () => {
    const input = replay();
    const parsed = parseOperationReplay(input);
    input.operation.status = 'failed';
    expect(parsed).toEqual(replay());
    expect(() => parseOperationReplay({ ...replay(), extra: true })).toThrow(
      'Invalid operation replay report'
    );
    expect(() =>
      parseOperationReplay({
        ...replay(),
        operation: { ...replay().operation, private: 'PRIVATE-REPLAY' },
      })
    ).toThrow('Invalid operation replay report');
  });

  it('rejects malformed records without echoing private response data', () => {
    const malformed = {
      replay: true,
      operation: { secret: 'PRIVATE-REPLAY', operationId: '../bad' },
    };
    expect(() => parseOperationReplay(malformed)).toThrow('Invalid operation replay report');
    try {
      parseOperationReplay(malformed);
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-REPLAY');
    }
  });
});
