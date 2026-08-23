import { describe, expect, it } from 'vitest';
import { resolveActiveSessionTmux } from '../../src/server/routes.js';
import type { Session } from '../../src/core/types.js';

const session: Session = {
  id: '9e8a1a22-7bfa-4dc5-bc3f-2c6bb008dde1',
  name: 'logical-worker',
  tmuxSession: 'echo-logical-worker',
  status: 'running',
  startedAt: '2026-08-23T07:15:44.000Z',
};

describe('resolveActiveSessionTmux', () => {
  it.each([
    ['UUID', session.id],
    ['logical name', session.name],
    ['tmux session', session.tmuxSession],
  ])('resolves %s to the active tmux session', (_form, identifier) => {
    expect(resolveActiveSessionTmux([session], identifier)).toBe(session.tmuxSession);
  });

  it('returns null for a genuinely unknown identifier', () => {
    expect(resolveActiveSessionTmux([session], 'unknown-session')).toBeNull();
  });
});
