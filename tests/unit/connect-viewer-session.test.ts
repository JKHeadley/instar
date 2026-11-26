import { expect, it, vi } from 'vitest';
import { ConnectViewerSession } from '../../src/core/ConnectViewerSession.js';
import { ConnectViewerFrameQueue } from "../../src/core/ConnectViewerFrameQueue.js";

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

it('refuses frame dispatch before attachment, after Stop, and after a delayed expiry timer', () => {
  vi.useFakeTimers();
  try {
    const start = Date.now();
    const session = new ConnectViewerSession({ ...viewer, displayId: 'display', expiresAt: start + 1000 });
    const deliver = vi.fn();
    expect(session.dispatchFrame(deliver)).toBe(false);
    const signal = session.attach(viewer, 'display');
    expect(session.dispatchFrame(deliver)).toBe(true);
    vi.setSystemTime(start + 1000);
    expect(session.dispatchFrame(deliver)).toBe(false);
    expect(signal?.aborted).toBe(true);
    session.stop();
    expect(session.dispatchFrame(deliver)).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('discards a pending frame when its connection is replaced before dispatch', () => {
  const connection = new AbortController();
  const session = new ConnectViewerSession({ ...viewer, displayId: 'display', expiresAt: Date.now() + 1000 }, connection.signal);
  const stream = session.attach(viewer, 'display');
  expect(stream?.aborted).toBe(false);
  const deliver = vi.fn();
  connection.abort();
  expect(stream?.aborted).toBe(true);
  expect(session.dispatchFrame(deliver)).toBe(false);
  expect(deliver).not.toHaveBeenCalled();
});

it('drops queued frames on abort and checks expiry at the final write', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const connection = new AbortController();
    const consent = { ...viewer, displayId: 'display', expiresAt: now + 1000 };
    const session = new ConnectViewerSession(consent, connection.signal);
    const queue = new ConnectViewerFrameQueue(session, session.attach(viewer, 'display')!);
    const write = vi.fn();
    expect(queue.offer(Buffer.from('first'))).toBe(true);
    expect(queue.offer(Buffer.from('latest'))).toBe(true);
    expect(queue.flush(write)).toBe(true);
    expect(write).toHaveBeenCalledWith(Buffer.from('latest'));
    expect(queue.offer(Buffer.from('pending'))).toBe(true);
    connection.abort();
    expect(queue.flush(write)).toBe(false);
    queue.close();

    const later = new ConnectViewerSession(consent);
    const expiring = new ConnectViewerFrameQueue(later, later.attach(viewer, 'display')!);
    expect(expiring.offer(Buffer.from('expires'))).toBe(true);
    vi.setSystemTime(now + 1000);
    expect(expiring.flush(write)).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expiring.close();
  } finally {
    vi.useRealTimers();
  }
});
