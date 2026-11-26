import { describe, it, expect } from 'vitest';
import {
  ForwardTransientError,
  ForwardBadRequestError,
  ForwardServerBootError,
  ForwardVersionSkewError,
  ForwardSecretRefusedError,
  isTerminalForwardError,
} from '../../../src/lifeline/forwardErrors.js';

describe('forwardErrors', () => {
  it('isTerminalForwardError: true for 426/400', () => {
    expect(isTerminalForwardError(new ForwardVersionSkewError(426, {}))).toBe(true);
    expect(isTerminalForwardError(new ForwardBadRequestError({}))).toBe(true);
  });

  it('isTerminalForwardError: false for transient / boot / unknown', () => {
    expect(isTerminalForwardError(new ForwardTransientError(500))).toBe(false);
    expect(isTerminalForwardError(new ForwardServerBootError(1000))).toBe(false);
    expect(isTerminalForwardError(new Error('random'))).toBe(false);
    expect(isTerminalForwardError('string')).toBe(false);
    expect(isTerminalForwardError(null)).toBe(false);
  });

  it('ForwardVersionSkewError carries body', () => {
    const err = new ForwardVersionSkewError(426, {
      upgradeRequired: true,
      serverVersion: '1.2.3',
      action: 'restart',
    });
    expect(err.body.serverVersion).toBe('1.2.3');
    expect(err.kind).toBe('version-skew');
  });

  it('a lifeline-secret refusal (after a re-read) is terminal for the retry loop and is its own kind', () => {
    const err = new ForwardSecretRefusedError();
    expect(err.kind).toBe('secret-refused');
    expect(isTerminalForwardError(err)).toBe(true);
    // A plain 401 (for example a Bearer failure) stays a retryable transient.
    expect(isTerminalForwardError(new ForwardTransientError(401))).toBe(false);
  });

  it('ForwardServerBootError carries retryAfterMs', () => {
    const err = new ForwardServerBootError(5000);
    expect(err.retryAfterMs).toBe(5000);
  });
});
