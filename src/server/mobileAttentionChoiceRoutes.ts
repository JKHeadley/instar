/**
 * Done and Ignore for a Needs-you item from the owner's phone (docs/specs/mobile-attention-choices.md).
 *
 *   POST /mobile/attention/:id/choice  { choice: 'done' | 'ignore' }
 *
 * A Needs-you item is an attention item, not a health problem, so the health quick actions (hide for a
 * while, hide from me, ignore) never reached it, and the phone showed it with no way to act. This route
 * runs the dashboard's own `PATCH /attention/:id` (`done` → DONE, `ignore` → WONT_DO), so that route's
 * rules stay in force: write admission on a standby, the not-found answer, the Telegram topic close.
 * Owner phones (device-signed, `ownerOnly` in DEVICE_ALLOWLIST) and the agent's token.
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer } from './mobileCapacityRoutes.js';

export type AttentionChoice = 'done' | 'ignore';
export const ATTENTION_CHOICE_STATUS: Record<AttentionChoice, 'DONE' | 'WONT_DO'> = { done: 'DONE', ignore: 'WONT_DO' };
/** The resolution recorded on the item, so the dashboard shows where it was settled. */
export const ATTENTION_CHOICE_RESOLUTION: Record<AttentionChoice, string> = {
  done: 'Marked done from the owner\'s phone.',
  ignore: 'Ignored from the owner\'s phone.',
};
/** An id with at least one letter or digit: a dot-only id would be resolved as a path step by the loopback URL. */
const ID = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._:-]{1,200}$/;

export interface AttentionChoiceDeps {
  /** Call a route on this server with its token. status 0: not reached. */
  call: (method: 'PATCH', path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  bearerOk: (req: Request) => boolean;
}

/** The phone's words for what the dashboard's route answered. */
export function choiceAnswer(choice: AttentionChoice, r: { status: number; body: unknown }): { status: number; body: Record<string, unknown> } {
  if (r.status >= 200 && r.status < 300) return { status: 200, body: { ok: true, message: choice === 'done' ? 'Marked done.' : 'Ignored. It won\'t ask again.' } };
  if (r.status === 404) return { status: 404, body: { ok: false, error: 'not-found', message: 'This is already gone. Pull to refresh.' } };
  if (r.status === 503 || r.status === 409) return { status: r.status, body: { ok: false, error: 'not-here', message: 'This machine can\'t change it right now. Try again in a moment.' } };
  return { status: r.status || 502, body: { ok: false, error: 'not-changed', message: r.status ? `Not changed: the agent answered ${r.status}. Try again.` : 'Not changed: the agent couldn\'t be reached. Try again.' } };
}

export function mountMobileAttentionChoiceRoutes(router: Router, deps: AttentionChoiceDeps): void {
  router.post('/mobile/attention/:id/choice', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (!ownerOrBearer(req, deps.bearerOk)) { res.status(403).json({ error: 'owner-phone-required', message: 'Only the owner\'s phone can change this.' }); return; }
    const id = String(req.params.id);
    const choice = (req.body as Record<string, unknown> | undefined)?.choice;
    if (!ID.test(id)) { res.status(400).json({ error: 'bad-id' }); return; }
    if (choice !== 'done' && choice !== 'ignore') { res.status(400).json({ error: 'bad-choice' }); return; }
    let r: { status: number; body: unknown };
    try {
      r = await deps.call('PATCH', `/attention/${encodeURIComponent(id)}`, { status: ATTENTION_CHOICE_STATUS[choice], resolution: ATTENTION_CHOICE_RESOLUTION[choice] });
    } catch { r = { status: 0, body: null }; } // @silent-fallback-ok — worded as not reached below
    const a = choiceAnswer(choice, r);
    res.status(a.status).json(a.body);
  });
}
