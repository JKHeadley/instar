/**
 * Unit tests — a grok pin must never brick a topic silently (round-11 security).
 *
 * `isLaunchable` tests the BINARY only, and the §5.2 disclosure path is driven
 * by it. On the DOCUMENTED reviewer posture — grok binary installed,
 * `enabledFrameworks` opt-in present, INTERACTIVE opt-in unset — a grok pin
 * resolved as launchable, no fallback notice fired, and every spawn threw
 * `grok-interactive-ungated`. The user's symptom was "an unexpected start-up
 * error", forever, with the pin never mentioned. That is the round-10 binary
 * defect one layer up: the disclosure carrier was blind to the gate that
 * actually refuses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-pin-admissibility-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/grok-build-pin-admissibility.test.ts:afterEach',
  });
});

function storeWithFrameworkPin(framework: string): TopicProfileStore {
  const stateFilePath = path.join(tmpDir, 'state', 'topic-profiles.json');
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(
    stateFilePath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      topics: {
        '13481': {
          current: {
            framework,
            updatedAt: new Date().toISOString(),
            updatedBy: 'telegram:777',
          },
          previous: null,
          intendedProfile: null,
          parked: null,
          breakerCount: 0,
        },
      },
    }),
    'utf-8',
  );
  return new TopicProfileStore({ stateFilePath });
}

/** A grok binary that genuinely exists, so launchability is never the reason. */
function realGrokBinary(): string {
  const bin = path.join(tmpDir, 'grok');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

function resolverFor(store: TopicProfileStore, grokInteractiveOptIn?: () => boolean): TopicProfileResolver {
  const bin = realGrokBinary();
  return new TopicProfileResolver({
    store,
    defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}),
    configProfileDefaults: () => ({}),
    frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined,
    localModelBinding: () => null,
    frameworkBinaryPath: (fw) => (fw === 'grok-build' ? bin : '/bin/sh'),
    ...(grokInteractiveOptIn ? { grokInteractiveOptIn } : {}),
  });
}

describe('grok pin admissibility (round-11)', () => {
  it('opt-in UNSET ⇒ falls back to the default framework WITH a disclosure notice', () => {
    const resolved = resolverFor(storeWithFrameworkPin('grok-build'), () => false).resolve('13481');
    expect(resolved.framework).toBe('claude-code');
    expect(resolved.notices.join(' ')).toContain('grok-build');
    // The whole point: the user learns the pin is not in force. Silence here is
    // the defect — the session would otherwise throw on every spawn forever.
    expect(resolved.notices.length).toBeGreaterThan(0);
  });

  it('opt-in SET ⇒ the pin holds and no fallback notice fires', () => {
    const resolved = resolverFor(storeWithFrameworkPin('grok-build'), () => true).resolve('13481');
    expect(resolved.framework).toBe('grok-build');
    expect(resolved.sources.framework).toBe('profile-pin');
    expect(resolved.notices).toEqual([]);
  });

  it('accessor ABSENT ⇒ degrades to binary-presence only (a blind probe never re-routes a valid pin)', () => {
    const resolved = resolverFor(storeWithFrameworkPin('grok-build')).resolve('13481');
    expect(resolved.framework).toBe('grok-build');
  });

  it('CONTROL: a non-grok pin is untouched by the grok gate', () => {
    const resolved = resolverFor(storeWithFrameworkPin('codex-cli'), () => false).resolve('13481');
    expect(resolved.framework).toBe('codex-cli');
    expect(resolved.notices).toEqual([]);
  });
});

describe('round-17: the pin notice names WHICH gate refused, not a generic one', () => {
  it('an ungated interactive opt-in produces its own reason and remedy', () => {
    // Round-11's single notice read "its CLI isn't launchable here" for BOTH
    // causes. On this posture — grok installed, opted into enabledFrameworks,
    // interactive opt-in unset — the CLI IS launchable, so the operator was
    // handed a remedy (install/repair the binary) that cannot fix their
    // problem, while the real remedy is a key the message never named. The
    // round-11 assertion could not see this: it checked only that the notice
    // contained 'grok-build', which the interpolated pin name satisfies
    // regardless of the sentence.
    const resolved = resolverFor(storeWithFrameworkPin('grok-build'), () => false).resolve('13481');
    expect(resolved.notices.join(' ')).toContain('second opt-in');
    expect(resolved.notices.join(' ')).toContain('sessions.grokInteractiveSessions');
    expect(resolved.notices.join(' ')).not.toContain("CLI isn't launchable");
  });

  it('CONTROL: with the opt-in SET, the pin holds and there is no fallback notice', () => {
    // Without this the assertion above would be satisfied by a resolver that
    // refused every grok pin with the new wording.
    const resolved = resolverFor(storeWithFrameworkPin('grok-build'), () => true).resolve('13481');
    expect(resolved.framework).toBe('grok-build');
  });
});
