/**
 * Email routes (docs/specs/backup-email-sending.md, Surfaces).
 *
 * POST /email/send-to-owner is a session's one-off: bearer, X-Instar-Request and the session's bind token, which is
 * where the fallback topic comes from (never the body). GET /email/outbox lists rows with hashes only. The
 * /recommended-services/email/* routes serve the setup session and the confirm page. No service: 503.
 */
import type { Request, Response, Router } from 'express';
import crypto from 'node:crypto';
import type { EmailService } from '../email/EmailService.js';
import { OWNER_TEXT_MAX_BYTES, SUBJECT_MAX_CHARS } from '../email/emailCore.js';

export interface EmailRouteDeps {
  service: () => EmailService | null;
  /** The session's bind token → the conversations it was started for. Null when the token is missing or invalid. */
  originTopics: (rawToken: string | undefined) => number[] | null;
  /** Memory privacy: true when a topic has readers other than the owner. */
  topicHasOtherReaders: (topicId: number) => boolean;
  /** The owner's yes for email stands on this machine. */
  hasGrant: () => boolean;
  /** PIN check with the unlock route's limits (the confirm page's own). */
  checkConfirmPin: (req: Request, res: Response) => boolean;
  /** This machine holds the lease. */
  holdsLease: () => boolean;
  /** A standby forwards a one-off to the holder by the signed `email-send-forward` mesh command. */
  forwardToHolder?: (input: { id: string; subject: string; text: string; fallbackTopicId: number }) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
}

const SAFE_ROW_FIELDS = ['id', 'createdAt', 'kind', 'subjectHash', 'textHash', 'fallbackTopicId', 'jobSlug', 'status', 'attempts', 'sentAt', 'reason', 'cause', 'terminalAt'] as const;

export function registerEmailRoutes(router: Router, deps: EmailRouteDeps): void {
  const svc = (res: Response): EmailService | null => {
    const s = deps.service();
    if (!s) res.status(503).json({ error: 'email-unavailable', detail: 'Email is not running on this machine.' });
    return s;
  };
  const needsHeader = (req: Request, res: Response): boolean => {
    if (req.headers['x-instar-request'] === '1') return false;
    res.status(403).json({ error: 'X-Instar-Request: 1 required' });
    return true;
  };

  router.get('/email/outbox', (req, res) => {
    const s = svc(res);
    if (!s) return;
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
    // Hashes only: the topic copy is report content, so it is not served here.
    const rows = s.outboxRows().slice(0, limit).map((r) => Object.fromEntries(SAFE_ROW_FIELDS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])));
    res.json({ rows, live: s.outboxRows().filter((r) => !['accepted', 'delivered', 'fallen-back', 'failed'].includes(r.status)).length });
  });

  router.post('/email/send-to-owner', async (req, res) => {
    const s = svc(res);
    if (!s) return;
    if (needsHeader(req, res)) return;
    const raw = req.headers['x-instar-bind-token'];
    const topics = deps.originTopics(Array.isArray(raw) ? raw[0] : raw);
    const topicId = topics?.find((t) => Number.isSafeInteger(t) && t > 0);
    if (topicId === undefined) {
      res.status(403).json({ error: 'no-origin-session', detail: 'Only a session started for a conversation can send email, and its fallback goes to that conversation.' });
      return;
    }
    const { subject, text } = (req.body ?? {}) as { subject?: unknown; text?: unknown };
    if (typeof subject !== 'string' || !subject.trim() || subject.length > SUBJECT_MAX_CHARS * 4) {
      res.status(400).json({ error: 'invalid-subject' });
      return;
    }
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > OWNER_TEXT_MAX_BYTES) {
      res.status(400).json({ error: 'invalid-text', detail: `Plain text, at most ${OWNER_TEXT_MAX_BYTES} bytes.` });
      return;
    }
    // A one-off has one text: never fall an owner-only text back into a shared conversation.
    if (deps.topicHasOtherReaders(topicId)) {
      res.status(409).json({ error: 'topic-not-owner-only', detail: 'This conversation has other readers, so I can’t send from it: if the email failed, its text would land here.' });
      return;
    }
    const id = `em-${crypto.randomBytes(12).toString('hex')}`;
    if (!deps.holdsLease()) {
      if (!deps.forwardToHolder) {
        res.status(503).json({ error: 'holder-unreachable' });
        return;
      }
      const fwd = await deps.forwardToHolder({ id, subject, text, fallbackTopicId: topicId }).catch(() => ({ ok: false as const, reason: 'holder-unreachable' }));
      if (!fwd.ok) {
        res.status(fwd.reason === 'credential-exposure' ? 422 : 503).json({ error: fwd.reason });
        return;
      }
      res.json({ id: fwd.id, forwarded: true });
      return;
    }
    const out = s.submit({ id, kind: 'one-off', subject, ownerText: text, topicText: text, fallbackTopicId: topicId });
    if (!out.ok) {
      res.status(out.reason === 'credential-exposure' ? 422 : 409).json({ error: out.reason, ...(out.reason === 'credential-exposure' ? { blockedBy: 'credential-exposure-guard', overridable: false } : {}) });
      return;
    }
    res.json({ id: out.id, status: out.status });
  });

  router.get('/recommended-services/email/status', (_req, res) => {
    const s = svc(res);
    if (!s) return;
    res.json(s.status());
  });

  /** The setup session's one read of the owner-typed address (shape A opens the account with it). */
  router.get('/recommended-services/email/recipient', (req, res) => {
    const s = svc(res);
    if (!s) return;
    if (needsHeader(req, res)) return;
    if (!deps.hasGrant()) {
      res.status(409).json({ error: 'not-granted-here' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ recipient: s.recipient() });
  });

  /** Shape A's signup mail reaches the same unconfirmed inbox, so it counts against the day's bound. */
  router.post('/recommended-services/email/signup-mail', (req, res) => {
    const s = svc(res);
    if (!s) return;
    if (needsHeader(req, res)) return;
    if (!deps.hasGrant()) {
      res.status(409).json({ error: 'not-granted-here' });
      return;
    }
    const verdict = s.countSignupMail();
    if (verdict !== 'ok') {
      res.status(429).json({ error: verdict, detail: 'Today’s limit of emails to an address the owner hasn’t confirmed yet is used up. Try again tomorrow.' });
      return;
    }
    res.json({ counted: true });
  });

  /** The owner enters the proof email's code on the confirm page, with their PIN. */
  router.post('/recommended-services/email/code', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = svc(res);
    if (!s) return;
    if (needsHeader(req, res)) return;
    if (!deps.hasGrant()) {
      res.status(409).json({ error: 'not-granted-here' });
      return;
    }
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string' || code.length > 16) {
      res.status(400).json({ error: 'invalid-code' });
      return;
    }
    if (!deps.checkConfirmPin(req, res)) return;
    const verdict = s.enterCode(code);
    if (verdict === 'ok') {
      res.json({ confirmed: true });
      return;
    }
    res.status(verdict === 'wrong' ? 400 : 409).json({ error: `code-${verdict}` });
  });
}
