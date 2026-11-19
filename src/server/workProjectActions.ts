/**
 * The owner's project taps from the phone (docs/specs/work-door-project-rows.md §3.3–3.5): Pause / Resume, Mark checked
 * and Finish. The phone write gate (mobilePermissionsRoutes.ts) has already proven the owner's phone and Face ID over
 * the exact action line before `apply` runs; `precheck` runs at the challenge (so a known refusal never reaches Face ID)
 * and again just before `apply`. Every answer carries the fresh project row, so the phone redraws from the server.
 */
import type { Request } from 'express';
import type { ChiefOfStaffLoop } from '../core/ChiefOfStaffLoop.js';
import type { ActionResult, ProjectAction, ProjectTapPort } from './mobilePermissionsRoutes.js';
import { projectRefusal, type ProjectRow } from './workProjectsRoutes.js';

type Loop = Pick<ChiefOfStaffLoop, 'appTapPrecheck' | 'appPause' | 'appItemCheck' | 'appFinish' | 'checkIn'>;

/** The precheck kind for one action. */
function precheckOf(loop: Loop, a: ProjectAction): ReturnType<Loop['appTapPrecheck']> {
  if (a.kind === 'project-pause') return loop.appTapPrecheck({ conversationKey: a.target, kind: a.value });
  if (a.kind === 'project-item-check') return loop.appTapPrecheck({ conversationKey: a.target, kind: 'item', itemId: a.itemId, checkRef: a.checkRef });
  return loop.appTapPrecheck({ conversationKey: a.target, kind: 'finish', bindingRef: a.bindingRef });
}

export function projectTapPort(loop: Loop, rowFor: (req: Request, key: string) => ProjectRow | null): ProjectTapPort {
  return {
    precheck: (a) => {
      const r = precheckOf(loop, a);
      return r.ok ? null : projectRefusal(r.reason);
    },
    apply: async (a, tap): Promise<ActionResult> => {
      // Every Chief of Staff tap is also a check-in (cos-owner-pause-record §3.2), made BEFORE a Finish so an owner who
      // has just used Face ID is never told to go and check in first.
      const checkIn = loop.checkIn({ renewedVia: 'app', principal: `device:${tap.deviceId}`, eventRef: `app:${tap.tapId}` });
      if (a.kind === 'project-finish' && !checkIn.ok) return projectRefusal('chief-of-staff-paused');
      let r: Awaited<ReturnType<Loop['appFinish']>>;
      if (a.kind === 'project-pause') r = await loop.appPause({ conversationKey: a.target, action: a.value, who: 'owner', note: tap.note, deviceId: tap.deviceId, tapId: tap.tapId });
      else if (a.kind === 'project-item-check') r = await loop.appItemCheck({ conversationKey: a.target, itemId: a.itemId, checkRef: a.checkRef, checked: a.value === 'checked', who: 'owner', deviceId: tap.deviceId, tapId: tap.tapId });
      else r = await loop.appFinish({ conversationKey: a.target, bindingRef: a.bindingRef });
      if (!r.ok) return projectRefusal(r.reason, 'failing' in r ? { failing: r.failing } : {});
      // A finished project leaves the list; its row is then null and the phone removes it.
      return { status: 200, body: { ok: true, done: a.kind === 'project-finish', project: rowFor(tap.req, a.target) } };
    },
  };
}
