/** Owner-selected priority is a project signal, never permission to override a pause or model pin. */
import type { Request, Router } from 'express';
import type { ChiefOfStaffLoop } from '../core/ChiefOfStaffLoop.js';
import { isProjectPriority, isValidConversationKey } from '../core/ChiefOfStaffStore.js';
export function mountProjectPriorityRoutes(router: Router, deps: {
  loop: () => Pick<ChiefOfStaffLoop, 'setProjectPriority'> | null;
  ownerProof: (req: Request) => boolean;
  invalidate: () => void;
}): void {
  router.post('/work/projects/:key/priority', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!deps.ownerProof(req)) { res.status(403).json({ error: 'owner-proof-required', detail: 'Unlock the dashboard to choose project priority.' }); return; }
    const key = String(req.params.key ?? '');
    const priority: unknown = req.body?.priority;
    if (!isValidConversationKey(key) || !isProjectPriority(priority)) { res.status(400).json({ error: 'invalid-project-priority', detail: 'Choose High, Normal or Low for a known project.' }); return; }
    const loop = deps.loop();
    if (!loop) { res.status(503).json({ error: 'chief-of-staff-off' }); return; }
    const result = await loop.setProjectPriority(key, priority);
    if (!result.ok) { res.status(result.reason === 'unknown-project' ? 404 : result.reason === 'invalid-priority' ? 400 : 409).json({ error: result.reason }); return; }
    deps.invalidate();
    res.json(result);
  });
}
