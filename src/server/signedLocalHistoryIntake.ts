import express, { type Request, type Response } from 'express';
import { activeOwnerPhone } from './mobileConsoleTicket.js';
import { deviceAdmissionIdentity, deviceAuthenticator, type MobilePairingService } from './mobilePairingRoutes.js';

export const SIGNED_LOCAL_HISTORY_PREFIX = '/mobile/imported-history/local';
const prefix = SIGNED_LOCAL_HISTORY_PREFIX;
export const LOCAL_HISTORY_CONSENT_PREVIEW_PATH = prefix + '/consent/preview';
const operation = '[a-f0-9]{32}';
const statusRoute = new RegExp(`^${prefix}/operations/${operation}$`);
const completeRoute = new RegExp(`^${prefix}/uploads/${operation}/complete$`);
const chunkRoute = new RegExp(`^${prefix}/uploads/${operation}/files/[A-Za-z0-9_-]{1,128}/chunks/(0|[1-9][0-9]{0,5})$`);
type Body = 'none' | 'json' | 'octet';
const mediaType = { json: 'application/json', octet: 'application/octet-stream' };

function bodyFor(method: string, pathname: string): Body | undefined {
  const route = pathname.slice(prefix.length);
  if (method === 'GET' && (route === '/targets' || statusRoute.test(pathname))) return 'none';
  if (method === 'POST' && pathname === LOCAL_HISTORY_CONSENT_PREVIEW_PATH) return 'octet';
  if (method === 'POST' && route === '/channels') return 'json';
  if (method === 'POST' && (['/challenge', '/uploads', '/cancel', '/preview', '/apply'].includes(route) || completeRoute.test(pathname))) return 'octet';
  if (method === 'PUT' && chunkRoute.test(pathname)) return 'octet';
  return undefined;
}

export interface SignedLocalHistoryIntakeRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: string;
  readonly body: Buffer;
  readonly recordHeader: string | undefined;
  readonly device: Readonly<{ deviceId: string; deviceKeyHash: string; ownerUserId: string }>;
  readonly signal: AbortSignal;
  /** Register cleanup for the authenticated exchange before opening it. */
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface SignedLocalHistoryIntakeReply {
  status: number;
  type: 'application/octet-stream' | 'application/json';
  body: Buffer;
}
export interface SignedLocalHistoryIntakeService {
  /** Hold the state-scoped exchange lease until the supplied work settles. */
  withExchange(work: () => Promise<void>): Promise<boolean>;
  dispatch(request: SignedLocalHistoryIntakeRequest): Promise<SignedLocalHistoryIntakeReply> | SignedLocalHistoryIntakeReply;
}

/** Mount before general body parsing and authentication. There is no default
 * service. The caller owns sealed-channel and copy authority after this gate. */
export function createSignedLocalHistoryIntake(options: {
  pairing: MobilePairingService;
  service(): SignedLocalHistoryIntakeService | undefined;
  consentPreview?(): SignedLocalHistoryIntakeService | undefined;
  wireBytes: number;
  deadlineMs?: number;
}) {
  const { wireBytes, deadlineMs = 30_000 } = options;
  if (!Number.isSafeInteger(wireBytes) || wireBytes < 24 || wireBytes > 1024 * 1024
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) throw new Error('signed-local-history-intake-policy');
  const auth = deviceAuthenticator(options.pairing);
  const read = (limit: number) => express.raw({ type: () => true, inflate: false, limit,
    verify(req, _res, bytes) { (req as Request & { rawBody?: Buffer }).rawBody = bytes; },
  });
  const json = read(4096), octet = read(wireBytes);
  let occupied = false;
  return (req: Request & { rawBody?: Buffer }, res: Response, next: express.NextFunction): void => {
    const mark = req.originalUrl.indexOf('?');
    const pathname = mark < 0 ? req.originalUrl : req.originalUrl.slice(0, mark);
    if (pathname.toLowerCase() !== prefix && !pathname.toLowerCase().startsWith(prefix + '/')) { next(); return; }
    const refuse = (status: number, error: string) => {
      if (res.destroyed || res.headersSent) { res.destroy(); return; }
      res.setHeader('Connection', 'close');
      res.status(status).json({ error });
    };
    res.setHeader('Cache-Control', 'no-store');
    const format = bodyFor(req.method, pathname);
    if (!pathname.startsWith(prefix + '/') || !format) { refuse(404, 'local-history-route'); return; }
    const service = pathname === LOCAL_HISTORY_CONSENT_PREVIEW_PATH ? options.consentPreview?.() : options.service();
    if (!service) { refuse(503, 'local-history-unavailable'); return; }
    const length = req.headers['content-length'];
    const declared = typeof length === 'string' && /^(0|[1-9][0-9]{0,8})$/.test(length) ? Number(length) : undefined;
    const encoding = req.headers['content-encoding'];
    const type = req.headers['content-type'];
    if ((encoding !== undefined && encoding !== 'identity') || req.headers['transfer-encoding'] !== undefined
      || (format === 'none' ? (declared ?? 0) !== 0 || (length !== undefined && declared === undefined) || type !== undefined
        : declared === undefined || declared === 0 || type !== mediaType[format] || declared > (format === 'json' ? 4096 : wireBytes))) {
      refuse(400, 'local-history-framing'); return;
    }
    const deviceId = req.headers['x-instar-device'];
    const signature = req.headers['x-instar-device-sig'];
    if (typeof deviceId !== 'string' || typeof signature !== 'string'
      || !activeOwnerPhone(options.pairing, deviceId)) { refuse(403, 'local-history-owner-required'); return; }
    if (req.rawBody !== undefined || req.body !== undefined) { refuse(503, 'local-history-parser-order'); return; }
    if (occupied) { refuse(429, 'local-history-busy'); return; }
    occupied = true;
    void Promise.resolve().then(() => service.withExchange(() => new Promise<void>(dispose => {
        const abort = new AbortController();
        let transportEnded = false, settled = false, released = false, reply: Buffer | undefined;
        let cleanup: (() => void | Promise<void>) | undefined;
        const release = () => {
          if (released || !transportEnded || !settled) return;
          released = true; clearTimeout(timer);
          req.rawBody?.fill(0);
          if (Buffer.isBuffer(req.body) && req.body !== req.rawBody) req.body.fill(0);
          reply?.fill(0);
          void Promise.resolve().then(cleanup).then(dispose, () => { /* Unproven cleanup keeps the lease. */ });
        };
        const ended = () => { transportEnded = true; abort.abort(); release(); };
        res.once('finish', ended); res.once('close', ended);
        const timer = setTimeout(() => { abort.abort(); req.destroy(); res.destroy(); }, deadlineMs);
        timer.unref();
        const dispatch = async () => {
          if (abort.signal.aborted) return;
          const verdict = auth(req, res);
          if (verdict === 'refused') return;
          const identity = deviceAdmissionIdentity(req);
          if (verdict !== 'ok' || !identity?.userId
            || identity.role !== 'owner' || !activeOwnerPhone(options.pairing, deviceId)) {
            refuse(403, 'local-history-owner-required'); return;
          }
          const record = req.headers['x-instar-local-history-record'];
          if (record !== undefined && typeof record !== 'string') { refuse(400, 'local-history-framing'); return; }
          const result = await service.dispatch({
            method: req.method, pathname, query: mark < 0 ? '' : req.originalUrl.slice(mark),
            body: req.rawBody ?? Buffer.alloc(0), recordHeader: record,
            device: Object.freeze({ deviceId, deviceKeyHash: identity.keyHash, ownerUserId: identity.userId }),
            signal: abort.signal,
            onDispose(run) {
              if (cleanup || typeof run !== 'function') throw new Error('local-history-disposer');
              cleanup = run;
            },
          });
          if (!Buffer.isBuffer(result.body)) throw new Error('local-history-response');
          reply = result.body;
          if (abort.signal.aborted) return;
          if (reply.length > wireBytes || !Number.isInteger(result.status) || result.status < 200 || result.status > 599
            || (result.type !== mediaType.json && result.type !== mediaType.octet)) throw new Error('local-history-response');
          res.status(result.status).type(result.type).end(reply);
        };
        const parseDone = (error?: unknown) => {
          if (error) { refuse(400, 'local-history-body'); settled = true; release(); return; }
          void dispatch().catch(() => refuse(503, 'local-history-unavailable'))
            .finally(() => { settled = true; release(); });
        };
        if (res.destroyed || res.writableFinished || req.destroyed && !req.complete) {
          settled = true; ended(); return;
        }
        if (format === 'none') parseDone();
        else (format === 'json' ? json : octet)(req, res, parseDone);
    }))).then(accepted => {
      if (!accepted) refuse(429, 'local-history-busy');
    }).catch(() => refuse(503, 'local-history-unavailable'))
      .finally(() => { occupied = false; });
  };
}
