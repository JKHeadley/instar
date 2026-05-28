import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReapNotifier, type ReapEvent } from '../../src/monitoring/ReapNotifier.js';
import type { Session } from '../../src/core/types.js';

function sess(name: string, tmux = name): Pick<Session, 'name' | 'tmuxSession'> {
  return { name, tmuxSession: tmux };
}

function makeNotifier(over?: {
  resolveTopic?: (t: string) => number | null;
  lifeline?: number | null;
  enabled?: boolean;
  windowMs?: number;
  maxBuffer?: number;
}) {
  const sends: Array<{ topicId: number; text: string }> = [];
  const lifeline = over && 'lifeline' in over ? (over.lifeline ?? null) : 999;
  const n = new ReapNotifier(
    {
      resolveTopic: over?.resolveTopic ?? (() => null),
      lifelineTopic: () => lifeline,
      send: (topicId, text) => { sends.push({ topicId, text }); },
    },
    { enabled: over?.enabled ?? true, coalesceWindowMs: over?.windowMs ?? 60_000, maxBuffer: over?.maxBuffer ?? 100 },
  );
  return { n, sends };
}

describe('ReapNotifier (§P3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays SILENT for a recovery-bounce reap', async () => {
    const { n, sends } = makeNotifier();
    n.onReaped({ session: sess('s1'), reason: 'context-exhaustion', disposition: 'recovery-bounce' });
    await n.flush();
    expect(sends).toHaveLength(0);
  });

  it('stays SILENT for an operator kill (the user did it themselves)', async () => {
    const { n, sends } = makeNotifier();
    n.onReaped({ session: sess('s1'), reason: 'operator-kill', disposition: 'terminal', origin: 'operator' });
    await n.flush();
    expect(sends).toHaveLength(0);
  });

  it('stays SILENT when disabled', async () => {
    const { n, sends } = makeNotifier({ enabled: false });
    n.onReaped({ session: sess('s1'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(0);
  });

  it('routes an isolated topic-bound reap to its BOUND topic', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => 42, lifeline: 999 });
    n.onReaped({ session: sess('alpha'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(42);
    expect(sends[0].text).toContain('alpha');
    expect(sends[0].text).toContain('idle-zombie');
  });

  it('routes an isolated UNBOUND reap to the lifeline topic', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => null, lifeline: 999 });
    n.onReaped({ session: sess('beta'), reason: 'age-limit', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(999);
  });

  it('coalesces a burst into ONE consolidated lifeline message with the exact total count', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => 42, lifeline: 999 });
    n.onReaped({ session: sess('a'), reason: 'boot-purge-dead', disposition: 'terminal' });
    n.onReaped({ session: sess('b'), reason: 'boot-purge-dead', disposition: 'terminal' });
    n.onReaped({ session: sess('c'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(999); // lifeline, not per-topic, for a burst
    expect(sends[0].text).toContain('3 sessions');
  });

  it('reports the exact total even when the detail buffer overflows (drop-oldest)', async () => {
    const { n, sends } = makeNotifier({ lifeline: 999, maxBuffer: 2 });
    for (let i = 0; i < 5; i++) {
      n.onReaped({ session: sess(`s${i}`), reason: 'idle-zombie', disposition: 'terminal' });
    }
    await n.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('5 sessions'); // count is exact regardless of buffer
    expect(sends[0].text).toMatch(/showing the latest 2/);
  });

  it('fires automatically when the coalesce window elapses (single shared timer)', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => 7, windowMs: 60_000 });
    n.onReaped({ session: sess('z'), reason: 'idle-zombie', disposition: 'terminal' });
    expect(sends).toHaveLength(0); // buffered, not yet sent
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(1);
  });

  it('wraps a malicious session name as a literal code span (never markup)', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => 7 });
    const evil: ReapEvent = {
      session: sess('*pwn* [x](http://e) `boom`', 'tmux1'),
      reason: 'idle-zombie',
      disposition: 'terminal',
    };
    n.onReaped(evil);
    await n.flush();
    // The dynamic value is wrapped in backticks and any inner backtick neutralized,
    // so the downstream formatter renders it as literal inline code, not markup.
    expect(sends[0].text).toContain('`*pwn* [x](http://e) ');
    expect(sends[0].text).not.toContain('`boom`'); // inner backticks neutralized
  });

  it('drops a single notice silently when no channel is reachable (reap-log still has it)', async () => {
    const { n, sends } = makeNotifier({ resolveTopic: () => null, lifeline: null });
    n.onReaped({ session: sess('orphan'), reason: 'idle-zombie', disposition: 'terminal' });
    await n.flush();
    expect(sends).toHaveLength(0); // no throw, no send
  });
});
