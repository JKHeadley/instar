import type { DirectDesktopAccess } from '../core/DirectDesktopAccess.js';

export interface DesktopRouteAccess {
  /** Front-only: serves browser admission, the target list and control routes. */
  directDesktopAccess: DirectDesktopAccess | null;
  /** Target-side: shows this host's own OS permission prompts on any machine
   *  that constructed desktop access. Grants nothing by itself. */
  desktopRequestPermission: DirectDesktopAccess['requestPermission'] | null;
}

/** Splits this machine's desktop target into what the routes may reach. Every
 *  target needs its own permission prompt; only the designated front serves
 *  the operator's desktop routes. */
export function desktopRouteAccess(
  access: DirectDesktopAccess | null,
  frontMachineId: string | undefined,
  selfMachineId: string | undefined,
): DesktopRouteAccess {
  return {
    directDesktopAccess: frontMachineId === selfMachineId ? access : null,
    desktopRequestPermission: access ? () => access.requestPermission() : null,
  };
}
