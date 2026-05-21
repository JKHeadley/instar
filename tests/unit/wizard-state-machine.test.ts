/**
 * Unit tests for the hybrid wizard state machine.
 *
 * Tier 1 (unit): exercise the state graph and the choice resolver in
 * isolation, with realistic user inputs. The driver (codex-driver.ts)
 * is exercised by the canary test that asserts shape and by manual
 * verification on a live Codex install.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFreshProjectInstall,
  INITIAL_STATE,
  resolveChoice,
  requireNonEmpty,
  requireChoice,
  type WizardAnswers,
} from '../../src/commands/setup-wizard/state-machine.js';

describe('requireNonEmpty', () => {
  const v = requireNonEmpty('name');

  it('rejects empty strings with a buffered-Enter-aware message', () => {
    const msg = v('');
    expect(msg).not.toBeNull();
    expect(msg!.toLowerCase()).toMatch(/blank/);
    expect(msg!.toLowerCase()).toMatch(/extra enter/);
    expect(msg!.toLowerCase()).toMatch(/name/);
  });

  it('rejects whitespace-only strings', () => {
    expect(v('   ')).not.toBeNull();
    expect(v('\t')).not.toBeNull();
    expect(v('\n')).not.toBeNull();
  });

  it('accepts any non-whitespace text', () => {
    expect(v('codey')).toBeNull();
    expect(v(' bob ')).toBeNull();
    expect(v('a')).toBeNull();
  });
});

describe('requireChoice', () => {
  const choices = [
    { value: 'yes', label: 'Yes, lets go' },
    { value: 'no', label: 'Not right now' },
  ];
  const v = requireChoice(choices);

  it('rejects empty input', () => {
    expect(v('')).not.toBeNull();
    expect(v('   ')).not.toBeNull();
  });

  it('rejects unmatched text', () => {
    expect(v('maybe')).not.toBeNull();
    expect(v('xyzzy')).not.toBeNull();
  });

  it('accepts numeric indices, value strings, and label prefixes', () => {
    expect(v('1')).toBeNull();
    expect(v('2')).toBeNull();
    expect(v('yes')).toBeNull();
    expect(v('Not')).toBeNull();
  });

  it('error message mentions the valid range', () => {
    const msg = v('garbage');
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/1-2/);
  });
});

describe('state machine validators wired correctly', () => {
  const states = buildFreshProjectInstall();

  it('agent-name validates non-empty (closes v1.2.13 buffered-Enter bug)', () => {
    const state = states['agent-name'];
    if (state?.kind !== 'narrative-then-prompt') return;
    expect(state.validate).toBeDefined();
    expect(state.validate!('')).not.toBeNull();
    expect(state.validate!('  ')).not.toBeNull();
    expect(state.validate!('codey')).toBeNull();
  });

  it('agent-role validates non-empty', () => {
    const state = states['agent-role'];
    if (state?.kind !== 'narrative-then-prompt') return;
    expect(state.validate).toBeDefined();
    expect(state.validate!('')).not.toBeNull();
    expect(state.validate!('coding agent')).toBeNull();
  });

  it('user-name validates non-empty', () => {
    const state = states['user-name'];
    if (state?.kind !== 'narrative-then-prompt') return;
    expect(state.validate).toBeDefined();
    expect(state.validate!('')).not.toBeNull();
    expect(state.validate!('Justin')).toBeNull();
  });

  it('welcome validates choice and rejects unmatched text', () => {
    const state = states.welcome;
    if (state?.kind !== 'narrative-then-prompt') return;
    expect(state.validate).toBeDefined();
    expect(state.validate!('')).not.toBeNull();
    expect(state.validate!('maybe later')).not.toBeNull();
    expect(state.validate!('1')).toBeNull();
    expect(state.validate!('yes')).toBeNull();
  });

  it('autonomy validates choice', () => {
    const state = states.autonomy;
    if (state?.kind !== 'narrative-then-prompt') return;
    expect(state.validate).toBeDefined();
    expect(state.validate!('')).not.toBeNull();
    expect(state.validate!('99')).not.toBeNull();
    expect(state.validate!('2')).toBeNull();
    expect(state.validate!('proactive')).toBeNull();
  });

  it('messaging validates choice', () => {
    const state = states.messaging;
    if (state?.kind !== 'narrative-then-prompt') return;
    expect(state.validate).toBeDefined();
    expect(state.validate!('')).not.toBeNull();
    expect(state.validate!('email')).not.toBeNull();
    expect(state.validate!('1')).toBeNull();
    expect(state.validate!('telegram')).toBeNull();
  });

  it('agent-name no longer silently defaults to "agent" on empty input', () => {
    // After validation accepts a real input, the transition should
    // use that input — NOT a fallback constant.
    const state = states['agent-name'];
    if (state?.kind !== 'narrative-then-prompt') return;
    const result = state.next('codey', {});
    expect(result.updates.agentName).toBe('codey');
    // The validator should have caught empty input before it reached
    // .next, so this is for theoretical robustness:
    const trimmed = state.next('  codey  ', {});
    expect(trimmed.updates.agentName).toBe('codey');
  });
});

describe('resolveChoice', () => {
  const choices = [
    { value: 'guided', label: 'Guided' },
    { value: 'proactive', label: 'Proactive' },
    { value: 'autonomous', label: 'Autonomous' },
  ];

  it('matches by 1-based numeric index', () => {
    expect(resolveChoice('1', choices)).toBe('guided');
    expect(resolveChoice('2', choices)).toBe('proactive');
    expect(resolveChoice('3', choices)).toBe('autonomous');
  });

  it('matches by value string (case-insensitive)', () => {
    expect(resolveChoice('Guided', choices)).toBe('guided');
    expect(resolveChoice('PROACTIVE', choices)).toBe('proactive');
    expect(resolveChoice('autonomous', choices)).toBe('autonomous');
  });

  it('matches by label prefix', () => {
    expect(resolveChoice('Pro', choices)).toBe('proactive');
    expect(resolveChoice('aut', choices)).toBe('autonomous');
  });

  it('returns null on no match or empty input', () => {
    expect(resolveChoice('', choices)).toBeNull();
    expect(resolveChoice('   ', choices)).toBeNull();
    expect(resolveChoice('zzz', choices)).toBeNull();
    expect(resolveChoice('99', choices)).toBeNull();
    expect(resolveChoice('0', choices)).toBeNull();
  });
});

describe('buildFreshProjectInstall — state graph integrity', () => {
  const states = buildFreshProjectInstall();

  it('has the expected initial state', () => {
    expect(states[INITIAL_STATE]).toBeDefined();
    expect(states[INITIAL_STATE]?.kind).toBe('narrative-then-prompt');
  });

  it('every non-terminal state has a valid next pointer', () => {
    for (const [id, state] of Object.entries(states)) {
      if (state.kind === 'terminal') continue;
      if (state.kind === 'narrative-then-prompt') {
        // We cannot enumerate all answers, but we can sanity-check the
        // resolver shape: feeding empty input and a few canonical
        // inputs should never throw.
        expect(() => state.next('', {})).not.toThrow();
        expect(() => state.next('1', {})).not.toThrow();
      } else if (state.kind === 'action') {
        expect(() => state.next({})).not.toThrow();
      }
      const nextId = state.kind === 'action' ? state.next({}) : state.next('1', {}).state;
      expect(states[nextId], `state ${id} → ${nextId} (does not exist)`).toBeDefined();
    }
  });

  it('terminates on welcome → decline path', () => {
    const welcome = states.welcome;
    expect(welcome?.kind).toBe('narrative-then-prompt');
    if (welcome?.kind !== 'narrative-then-prompt') return;
    const { state: next } = welcome.next('2', {});
    expect(next).toBe('declined');
    expect(states.declined?.kind).toBe('terminal');
  });

  it('threads identity answers through to autonomy', () => {
    const answers: WizardAnswers = {};
    const welcome = states.welcome;
    if (welcome?.kind !== 'narrative-then-prompt') return;
    let { state: nextId, updates } = welcome.next('1', answers);
    Object.assign(answers, updates);
    expect(nextId).toBe('agent-name');

    const agentName = states[nextId];
    if (agentName?.kind !== 'narrative-then-prompt') return;
    ({ state: nextId, updates } = agentName.next('codey', answers));
    Object.assign(answers, updates);
    expect(answers.agentName).toBe('codey');
    expect(nextId).toBe('agent-role');

    const agentRole = states[nextId];
    if (agentRole?.kind !== 'narrative-then-prompt') return;
    ({ state: nextId, updates } = agentRole.next('coding assistant', answers));
    Object.assign(answers, updates);
    expect(answers.agentRole).toBe('coding assistant');
    expect(nextId).toBe('user-name');

    const userName = states[nextId];
    if (userName?.kind !== 'narrative-then-prompt') return;
    ({ state: nextId, updates } = userName.next('Justin', answers));
    Object.assign(answers, updates);
    expect(answers.userName).toBe('Justin');
    expect(nextId).toBe('autonomy');

    const autonomy = states[nextId];
    if (autonomy?.kind !== 'narrative-then-prompt') return;
    ({ state: nextId, updates } = autonomy.next('2', answers));
    Object.assign(answers, updates);
    expect(answers.autonomy).toBe('proactive');
    expect(nextId).toBe('do-init');
  });

  it('routes messaging choice to the right setup action', () => {
    const messaging = states.messaging;
    if (messaging?.kind !== 'narrative-then-prompt') return;
    expect(messaging.next('1', {}).state).toBe('do-telegram');
    expect(messaging.next('2', {}).state).toBe('do-whatsapp');
    expect(messaging.next('3', {}).state).toBe('do-slack');
    expect(messaging.next('4', {}).state).toBe('do-start-server');
    expect(messaging.next('skip', {}).state).toBe('do-start-server');
  });

  it('all three messaging-action states route to start-server', () => {
    for (const id of ['do-telegram', 'do-whatsapp', 'do-slack']) {
      const state = states[id];
      expect(state?.kind).toBe('action');
      if (state?.kind !== 'action') continue;
      expect(state.next({})).toBe('do-start-server');
    }
  });

  it('post-server chain completes at terminal `complete`', () => {
    const startServer = states['do-start-server'];
    if (startServer?.kind !== 'action') return;
    expect(startServer.next({})).toBe('do-install-autostart');

    const autostart = states['do-install-autostart'];
    if (autostart?.kind !== 'action') return;
    expect(autostart.next({})).toBe('do-send-greeting');

    const greeting = states['do-send-greeting'];
    if (greeting?.kind !== 'action') return;
    expect(greeting.next({})).toBe('complete');

    expect(states.complete?.kind).toBe('terminal');
  });

  it('terminal farewell mentions chatting the agent to change settings', () => {
    const complete = states.complete;
    if (complete?.kind !== 'terminal') return;
    expect(complete.farewell.toLowerCase()).toMatch(/chang/);
    expect(complete.farewell.toLowerCase()).toMatch(/ask/);
  });
});
