/**
 * Unit — grok's headless (background job) lane is OPEN, and the bound that
 * replaced the blanket refusal.
 *
 * HISTORY, because the change is a narrowing rather than a removal. The lane
 * used to refuse every grok job with `grok-headless-cwd-ungated`, pending "a
 * scratch cwd at the SessionManager spawn site". On a grok-primary agent that
 * meant all 33 shipped jobs failed on their schedule, forever — the operator saw
 * a steady drip of "Job Alert: … 14 consecutive failures".
 *
 * Justin's decision (2026-08-16): "sounds like this part needs to be built".
 *
 * WHY NOT THE SCRATCH CWD THE OLD NOTE ASKED FOR. Measured, not assumed: the
 * shipped job bodies read `.instar/config.json` and `.instar/state/*` by
 * RELATIVE path. An empty temp dir would satisfy the letter of that note and
 * leave the lane useless — the jobs would run and fail differently. The note's
 * actual concern was narrower than its proposed remedy: "running a
 * self-updating CLI with the repo as its working tree".
 *
 * So the bound moved to exactly that case. An ordinary agent's spawn cwd is its
 * own agent home (config + state), which is what the jobs need. A DEV agent's is
 * an instar checkout, which is what grok must not be turned loose in.
 */

import { describe, it, expect } from 'vitest';
import {
  buildHeadlessLaunch,
  headlessLaneIsClosed,
} from '../../src/core/frameworkSessionLaunch.js';

describe('grok-build headless lane', () => {
  it('no longer refuses — a job build returns real argv', () => {
    // The whole point. Before this change the builder threw
    // `grok-headless-cwd-ungated` unconditionally.
    const spec = buildHeadlessLaunch('grok-build', {
      binaryPath: '/opt/grok/bin/grok',
      prompt: 'run a health check',
    });
    expect(spec.argv[0]).toBe('/opt/grok/bin/grok');
    expect(spec.argv).toContain('-p');
    // The prompt is exactly ONE argv element after -p, so a leading-dash prompt
    // can never be re-parsed as a flag.
    expect(spec.argv[spec.argv.indexOf('-p') + 1]).toBe('run a health check');
  });

  it('the lane reports itself OPEN', () => {
    expect(headlessLaneIsClosed('grok-build')).toBe(false);
  });

  it('forces the api-key kill switch and CLEARS billing vars on every job spawn', () => {
    // The billing sink is UNPROVEN for grok (spec §0.0), so a metered key must
    // be unreachable from a job. tmux MERGES these into the inherited server
    // environment, so an unset is not enough — they are cleared explicitly.
    const spec = buildHeadlessLaunch('grok-build', {
      binaryPath: '/opt/grok/bin/grok',
      prompt: 'x',
    });
    expect(spec.envOverrides['GROK_DISABLE_API_KEY_AUTH']).toBe('1');
    expect(spec.envOverrides['XAI_API_KEY']).toBe('');
    expect(spec.envOverrides['GROK_API_KEY']).toBe('');
  });

  it('passes a model through when the caller supplies one', () => {
    const spec = buildHeadlessLaunch('grok-build', {
      binaryPath: '/opt/grok/bin/grok',
      prompt: 'x',
      model: 'grok-4.6',
    });
    expect(spec.argv).toContain('--model');
    expect(spec.argv[spec.argv.indexOf('--model') + 1]).toBe('grok-4.6');
  });

  it('CONTROL: omits the model flag entirely when none is given', () => {
    // A bare `--model` with no value, or the string "undefined", would be a
    // silent mis-spawn. Absence must mean absence.
    const spec = buildHeadlessLaunch('grok-build', {
      binaryPath: '/opt/grok/bin/grok',
      prompt: 'x',
    });
    expect(spec.argv).not.toContain('--model');
    expect(spec.argv.join(' ')).not.toContain('undefined');
  });

  it('CONTROL: the other frameworks are untouched by opening grok', () => {
    // Opening one lane must not open or alter another. claude-code is the
    // reference shape.
    expect(headlessLaneIsClosed('claude-code')).toBe(false);
    expect(headlessLaneIsClosed('codex-cli')).toBe(false);
    const claude = buildHeadlessLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      prompt: 'hello',
    });
    expect(claude.argv[0]).toBe('/usr/local/bin/claude');
    expect(claude.envOverrides['GROK_DISABLE_API_KEY_AUTH']).toBeUndefined();
  });
});
