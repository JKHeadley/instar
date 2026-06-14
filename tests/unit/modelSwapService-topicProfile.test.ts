/**
 * Unit tests — the TOPIC-PROFILE-SPEC §9 pin consult in ModelSwapService.
 *
 * Wiring-integrity both directions (§11):
 *  - an `inherit` pinned topic IS still escalated for heavy work;
 *  - a `suppress` pinned topic is NEVER escalated (refused with the named
 *    reason);
 *  - de-escalation (`tier:'default'`) lands on the TOPIC's pinned baseline,
 *    never the global default (round-4: the swap-back must not silently drop
 *    the operator's pin);
 *  - a consult id outside the closed enum NEVER reaches send-keys (falls to
 *    the resolver, defense in depth);
 *  - no consult wired / consult throws ⇒ today's exact behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelSwapService, type SwapSessionFacade } from '../../src/core/ModelSwapService.js';
import {
  DEFAULT_TIER_ESCALATION_CONFIG,
  normalizeTierEscalationConfig,
} from '../../src/core/ModelTierEscalation.js';
import type { Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const IDLE_TAIL = [
  '╭──────────────────────────────╮',
  '│ >                            │',
  '╰──────────────────────────────╯',
  '  bypass permissions on (shift+tab to cycle)',
].join('\n');

const CONFIRM_TAIL = (id: string) => `${IDLE_TAIL}\n⎿ Set model to ${id} (custom)\n`;

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-swap-profile-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/modelSwapService-topicProfile.test.ts:cleanup',
  });
});

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'inst-1',
    name: 'topic-chat',
    status: 'running',
    tmuxSession: 'proj-topic-chat',
    startedAt: new Date().toISOString(),
    framework: 'claude-code',
    model: 'claude-opus-4-8',
    ...overrides,
  };
}

function service(opts: {
  session: Session;
  consult?: (s: Session) => { suppressEscalation: boolean; baselineModel: string | null } | null;
  injected: string[];
  confirmId?: string;
}): ModelSwapService {
  const facade: SwapSessionFacade = {
    listRunningSessions: () => [opts.session],
    captureMeaningfulTail: (_t, lines) =>
      opts.injected.length > 0 && lines >= 30 && opts.confirmId
        ? CONFIRM_TAIL(opts.confirmId)
        : IDLE_TAIL,
    sendInput: (_t, input) => {
      opts.injected.push(input);
      return true;
    },
  };
  return new ModelSwapService({
    stateDir,
    sessions: facade,
    saveSession: () => {},
    protectedSessions: () => [],
    getConfig: () =>
      normalizeTierEscalationConfig({
        ...DEFAULT_TIER_ESCALATION_CONFIG,
        enabled: true,
        dryRun: false,
      }),
    governor: {
      admitEscalation: () => ({ allow: true }),
      recordInjection: () => true,
    } as never,
    ...(opts.consult ? { topicProfileConsult: opts.consult } : {}),
    canaryAttempts: 3,
    canaryIntervalMs: 1,
    wait: () => Promise.resolve(),
  });
}

describe('§9 pin consult — escalation arm', () => {
  it('a suppress-pinned topic is NEVER escalated (named refusal, nothing injected)', async () => {
    const injected: string[] = [];
    const svc = service({
      session: makeSession(),
      injected,
      consult: () => ({ suppressEscalation: true, baselineModel: null }),
    });
    const result = await svc.swap('topic-chat', 'escalated');
    expect(result.status).toBe('refused');
    expect(result.reason).toBe('profile-suppresses-escalation');
    expect(injected).toEqual([]);
  });

  it('an inherit-pinned topic IS still escalated for heavy work', async () => {
    const injected: string[] = [];
    const svc = service({
      session: makeSession(),
      injected,
      confirmId: 'claude-fable-5',
      consult: () => ({ suppressEscalation: false, baselineModel: 'claude-opus-4-8' }),
    });
    const result = await svc.swap('topic-chat', 'escalated');
    expect(result.status).toBe('swapped');
    expect(result.model).toBe('claude-fable-5');
    expect(injected[0]).toContain('/model claude-fable-5');
  });
});

describe('§9 pin consult — de-escalation lands on the topic baseline', () => {
  it("tier:'default' resolves to the pinned baseline, not the global default", async () => {
    const injected: string[] = [];
    const svc = service({
      session: makeSession({ model: 'claude-fable-5' }),
      injected,
      confirmId: 'claude-opus-4-6',
      consult: () => ({ suppressEscalation: false, baselineModel: 'claude-opus-4-6' }),
    });
    const result = await svc.swap('topic-chat', 'default');
    expect(result.status).toBe('swapped');
    expect(result.model).toBe('claude-opus-4-6'); // the PIN, not claude-opus-4-8
    expect(injected[0]).toContain('/model claude-opus-4-6');
  });

  it('falls to the global default when no pin exists', async () => {
    const injected: string[] = [];
    const svc = service({
      session: makeSession({ model: 'claude-fable-5' }),
      injected,
      confirmId: 'claude-opus-4-8',
      consult: () => null,
    });
    const result = await svc.swap('topic-chat', 'default');
    expect(result.status).toBe('swapped');
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('an off-enum consult id NEVER reaches send-keys (falls to the resolver)', async () => {
    const injected: string[] = [];
    const svc = service({
      session: makeSession({ model: 'claude-fable-5' }),
      injected,
      confirmId: 'claude-opus-4-8',
      consult: () => ({ suppressEscalation: false, baselineModel: 'evil; rm -rf /' }),
    });
    const result = await svc.swap('topic-chat', 'default');
    expect(result.status).toBe('swapped');
    expect(result.model).toBe('claude-opus-4-8'); // resolver default, not the bad id
    expect(injected.every(i => !i.includes('evil'))).toBe(true);
  });
});

describe('§9 pin consult — fail-soft', () => {
  it('a throwing consult keeps today\'s behavior', async () => {
    const injected: string[] = [];
    const svc = service({
      session: makeSession(),
      injected,
      confirmId: 'claude-fable-5',
      consult: () => { throw new Error('resolver exploded'); },
    });
    const result = await svc.swap('topic-chat', 'escalated');
    expect(result.status).toBe('swapped');
    expect(result.model).toBe('claude-fable-5');
  });

  it('no consult wired keeps today\'s behavior (back-compat)', async () => {
    const injected: string[] = [];
    const svc = service({ session: makeSession(), injected, confirmId: 'claude-fable-5' });
    const result = await svc.swap('topic-chat', 'escalated');
    expect(result.status).toBe('swapped');
  });
});
