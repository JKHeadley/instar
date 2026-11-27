/**
 * `--auto` honours the local floor. Since ci.yml skips the heavy jobs on pull
 * requests (2026-11-21), a caller that asks for `--auto` under the `local` floor
 * (the feedback executor does) must take the local path, not wait on Actions
 * checks that never run.
 */
import { describe, it, expect } from 'vitest';
import { autoTakesActionsFloor } from '../../scripts/safe-merge.mjs';

describe('autoTakesActionsFloor', () => {
  it('takes the Actions path only for --auto under the actions floor', () => {
    expect(autoTakesActionsFloor({ auto: true }, { floor: 'actions', reason: 'config-actions' })).toBe(true);
    expect(autoTakesActionsFloor({ auto: true }, { floor: 'actions', reason: 'override' })).toBe(true);
  });

  it('falls through to the local path for --auto under the local floor, including an unmeasurable local refusal', () => {
    expect(autoTakesActionsFloor({ auto: true }, { floor: 'local', status: {} })).toBe(false);
    expect(autoTakesActionsFloor({ auto: true }, { floor: 'local', refusal: { result: 'refused:verify-record-unmeasurable', problems: ['x'] } })).toBe(false);
  });

  it('never takes the Actions --auto path without --auto', () => {
    expect(autoTakesActionsFloor({ auto: false }, { floor: 'actions' })).toBe(false);
    expect(autoTakesActionsFloor({}, { floor: 'actions' })).toBe(false);
    expect(autoTakesActionsFloor(undefined, undefined)).toBe(false);
  });
});
