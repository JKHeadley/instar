import { describe, expect, it, vi } from 'vitest';
import { desktopRouteAccess } from '../../src/server/desktopRouteContext.js';
import type { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';

const answer = { screenPermission: true, inputPermission: true };
const fakeAccess = () => {
  const requestPermission = vi.fn(async () => answer);
  return { access: { requestPermission } as unknown as DirectDesktopAccess, requestPermission };
};

describe('desktopRouteAccess', () => {
  it('gives the designated front both surfaces', () => {
    const { access } = fakeAccess();
    const routes = desktopRouteAccess(access, 'm_front', 'm_front');
    expect(routes.directDesktopAccess).toBe(access);
    expect(routes.desktopRequestPermission).toBeTypeOf('function');
  });

  it('gives a non-front target only the permission prompt, delegating to its real access', async () => {
    const { access, requestPermission } = fakeAccess();
    const routes = desktopRouteAccess(access, 'm_front', 'm_target');
    expect(routes.directDesktopAccess).toBeNull();
    await expect(routes.desktopRequestPermission!()).resolves.toEqual(answer);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('keeps the prompt off where no desktop target was constructed', () => {
    expect(desktopRouteAccess(null, 'm_front', 'm_front')).toEqual({
      directDesktopAccess: null, desktopRequestPermission: null });
    expect(desktopRouteAccess(null, 'm_front', 'm_target')).toEqual({
      directDesktopAccess: null, desktopRequestPermission: null });
  });
});
