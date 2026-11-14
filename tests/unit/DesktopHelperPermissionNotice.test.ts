import { describe, expect, it, vi } from 'vitest';
import { DesktopHelperPermissionNotice } from '../../src/core/DesktopHelperPermissionNotice.js';
import { desktopProbeUnavailableReason } from '../../src/core/DesktopProbeReadiness.js';

const change = { kind: 'source-changed' as const, version: '1.3.1580', helperPath: '/Users/x/.instar/desktop-helper/instar-desktop-host' };
const base = { displayCount: 1, sessionActive: true, ready: false };
const missing = { ...base, screenPermission: false, inputPermission: false, helperChange: change };
const granted = { ...base, ready: true, screenPermission: true, inputPermission: true };

function notice(probes: unknown[], claim = () => true) {
  const raise = vi.fn(async () => undefined);
  const clear = vi.fn();
  const release = vi.fn();
  let i = 0;
  const subject = new DesktopHelperPermissionNotice({
    machineLabel: 'the Mini', machineId: 'm_1', sourceHash: () => 'a'.repeat(64), claim, raise, clear, release,
    probe: async () => probes[Math.min(i++, probes.length - 1)] as never,
  });
  return { subject, raise, clear, release };
}

describe('desktop helper permission wording', () => {
  it('says the update removed it and that it will not fix itself', () => {
    const reason = desktopProbeUnavailableReason(missing);
    expect(reason).toContain('changed in update 1.3.1580');
    expect(reason).toContain('Screen Recording and Accessibility');
    expect(reason).toContain('will not fix itself');
    expect(reason).toContain(change.helperPath);
  });

  it('names only what is missing', () => {
    const reason = desktopProbeUnavailableReason({ ...missing, screenPermission: true });
    expect(reason).toContain('→ Accessibility.');
    expect(reason).not.toContain('Screen Recording');
  });

  it('explains the one-time move on a Mac that never granted the kept copy', () => {
    expect(desktopProbeUnavailableReason({ ...missing, helperChange: { ...change, kind: 'first-grant' } }))
      .toContain('one permanent copy');
  });

  it('keeps the ordinary wording when no update is involved', () => {
    const { helperChange: _none, ...plain } = missing;
    const reason = desktopProbeUnavailableReason(plain);
    expect(reason).toContain('Screen capture permission is unavailable');
    expect(reason).not.toContain('update');
  });

  it('carries the update reason at a locked screen too', () => {
    expect(desktopProbeUnavailableReason({ ...missing, sessionActive: false, screenLocked: true }))
      .toContain('will not fix itself');
  });
});

describe('DesktopHelperPermissionNotice', () => {
  it('raises once with the plain reason, then closes itself when granted', async () => {
    const { subject, raise, clear } = notice([missing, missing, granted]);
    await subject.check();
    await subject.check();
    expect(raise).toHaveBeenCalledOnce();
    expect(raise.mock.calls[0]![0]).toMatchObject({
      conditionKey: `desktop-helper-permission:m_1:${'a'.repeat(16)}`,
      title: 'the Mini: Remote Desktop needs its Mac permission again',
    });
    expect((raise.mock.calls[0]![0] as { body: string }).body).toContain('will not fix itself');
    await subject.check();
    expect(clear).toHaveBeenCalledOnce();
  });

  it('stays quiet when another agent on this Mac already raised it', async () => {
    const { subject, raise } = notice([missing], () => false);
    await subject.check();
    expect(raise).not.toHaveBeenCalled();
  });

  it('stays quiet when a missing permission is not about an update', async () => {
    const { helperChange: _none, ...plain } = missing;
    const { subject, raise } = notice([plain]);
    await subject.check();
    expect(raise).not.toHaveBeenCalled();
  });

  it('raises nothing on a ready Mac', async () => {
    const { subject, raise } = notice([granted]);
    await subject.check();
    expect(raise).not.toHaveBeenCalled();
  });

  it('closes an item raised before a restart', async () => {
    const { subject, clear } = notice([granted]);
    await subject.check();
    expect(clear).toHaveBeenCalledWith(`desktop-helper-permission:m_1:${'a'.repeat(16)}`, expect.any(String));
  });

  it('gives the claim back when raising fails, so the item is not lost', async () => {
    const { subject, raise, release } = notice([missing, missing]);
    raise.mockRejectedValueOnce(new Error('telegram down'));
    await expect(subject.check()).rejects.toThrow('telegram down');
    expect(release).toHaveBeenCalledOnce();
    await subject.check();
    expect(raise).toHaveBeenCalledTimes(2);
  });
});
