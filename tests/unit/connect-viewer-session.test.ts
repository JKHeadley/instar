import { expect, it, vi } from 'vitest';
import { ConnectViewerSession } from '../../src/core/ConnectViewerSession.js';

const viewer = { agentId: 'agent', targetMachineId: 'machine', keyDigest: 'viewer-key' };

it('attaches one matching display and cancels its stream on Stop', () => {
  const session = new ConnectViewerSession({ ...viewer, displayId: 'display', expiresAt: Date.now() + 1000 });
  try {
    expect(session.attach({ ...viewer, keyDigest: 'different-key' }, 'display')).toBeUndefined();
    expect(session.attach(viewer, 'different-display')).toBeUndefined();
    const signal = session.attach(viewer, 'display');
    expect(signal?.aborted).toBe(false);
    expect(session.attach(viewer, 'display')).toBeUndefined();
    session.stop();
    expect(signal?.aborted).toBe(true);
    expect(session.attach(viewer, 'display')).toBeUndefined();
  } finally {
    session.stop();
  }
});

it('cancels an attached stream at consent expiry', () => {
  vi.useFakeTimers();
  try {
    const session = new ConnectViewerSession({ ...viewer, displayId: 'display', expiresAt: Date.now() + 1000 });
    const signal = session.attach(viewer, 'display');
    vi.advanceTimersByTime(1000);
    expect(signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
