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
import fs from 'node:fs';
import path from 'node:path';
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
    expect(spec.argv).toContain('--prompt-file');
  });

  it('puts the prompt in a private FILE, never on argv', () => {
    // argv is world-readable — `ps` shows every process's full command line to
    // any local principal — so a prompt passed as `-p <text>` is legible to
    // anything on the machine for the life of the job. The first cut of this
    // builder did exactly that under a self-granted carve-out for "internal
    // scheduler-authored prompts"; job prompts carry task context and the
    // exposure does not care who wrote the string.
    const secret = 'summarise the deploy log for topic 44867';
    const spec = buildHeadlessLaunch('grok-build', {
      binaryPath: '/opt/grok/bin/grok',
      prompt: secret,
    });
    // Not anywhere on the command line — asserted over the WHOLE argv, not just
    // the slot after the flag, so a future builder cannot reintroduce it
    // elsewhere and still pass.
    expect(spec.argv.join(' ')).not.toContain(secret);
    expect(spec.argv).not.toContain('-p');
    // ...and genuinely readable from the file the flag points at. Reading it
    // back is what distinguishes a real handoff from a plausible-looking path.
    const file = spec.argv[spec.argv.indexOf('--prompt-file') + 1]!;
    expect(fs.readFileSync(file, 'utf8')).toBe(secret);
  });

  it('the prompt file is owner-only and in a per-call unpredictable directory', () => {
    // 0600 because the point of moving off argv is that other local principals
    // cannot read the prompt; a world-readable file would just relocate the
    // exposure. mkdtemp because a fixed shared path under tmpdir is
    // pre-creatable by another principal.
    const a = buildHeadlessLaunch('grok-build', { binaryPath: '/opt/grok/bin/grok', prompt: 'x' });
    const b = buildHeadlessLaunch('grok-build', { binaryPath: '/opt/grok/bin/grok', prompt: 'x' });
    const fileA = a.argv[a.argv.indexOf('--prompt-file') + 1]!;
    const fileB = b.argv[b.argv.indexOf('--prompt-file') + 1]!;
    expect(fileA).not.toBe(fileB);
    expect(fs.statSync(fileA).mode & 0o777).toBe(0o600);
    // Same prefix the adapter lane uses, so the crash-orphan sweeper that
    // already exists there collects these too rather than leaking dirs forever.
    expect(path.basename(path.dirname(fileA)).startsWith('grok-scratch-')).toBe(true);
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

  it('maps a GENERIC tier to a real grok model — never passes a Claude tier through', () => {
    // THE BUG THIS PINS, found by Justin asking "what door + model do the jobs
    // use?" — a question I could not answer from assumption, which is why it
    // caught something.
    //
    // Job manifests declare generic tiers (`model: haiku`). Every other headless
    // builder routes that through resolveModelForFramework; this one pushed
    // options.model verbatim. So grok received `--model haiku`, answered
    //   Couldn't set model 'haiku': Invalid params: "unknown model id"
    // and EXITED 0 — so instar logged `result: "success"` for jobs that did
    // nothing. Opening the lane had converted a LOUD failure into a silent one,
    // which is worse than the refusal it replaced.
    for (const tier of ['haiku', 'fast', 'sonnet', 'balanced', 'opus', 'capable']) {
      const spec = buildHeadlessLaunch('grok-build', {
        binaryPath: '/opt/grok/bin/grok',
        prompt: 'x',
        model: tier,
      });
      const emitted = spec.argv[spec.argv.indexOf('--model') + 1];
      expect(emitted, `tier '${tier}' must not reach grok verbatim`).not.toBe(tier);
      // Verified against the live CLI: `grok models` lists exactly these two.
      expect(['grok-4.6', 'grok-4.5']).toContain(emitted);
    }
  });

  it('CONTROL: a real grok model id passes through untouched', () => {
    // The mapper must not "helpfully" rewrite an id the caller already resolved.
    const spec = buildHeadlessLaunch('grok-build', {
      binaryPath: '/opt/grok/bin/grok',
      prompt: 'x',
      model: 'grok-4.5',
    });
    expect(spec.argv[spec.argv.indexOf('--model') + 1]).toBe('grok-4.5');
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
