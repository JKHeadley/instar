/**
 * FeatureActionApplier — sends a feature's enableAction / disableAction to the
 * server's own route, so a feature switch changes the setting it names.
 *
 * Spec: docs/specs/feature-transition-applies-action.md §2.1.
 *
 * Why a loopback request and not a function call: the targets are different
 * routes (PATCH /config, PATCH /api/files/config, POST /telemetry/enable|disable)
 * and each already owns its validation (key allowlist, executable fence, CSRF
 * header, write admission). Going through the route means the switch can never
 * apply anything the route itself would refuse.
 *
 * The action always comes from the static FeatureDefinition in code; nothing a
 * caller sends reaches the method, path or body.
 */

import http from 'node:http';

import type { EnableAction } from './FeatureRegistry.js';

export type FeatureApplyOutcome = 'applied' | 'refused' | 'failed' | 'not-applied';

export interface FeatureApplyResult {
  direction: 'enable' | 'disable';
  outcome: FeatureApplyOutcome;
  /** HTTP status the route answered; null when no answer (not sent, timeout, connection error). */
  httpStatus: number | null;
  /** Short plain reason: the route's error text, or why it was not sent. */
  detail: string | null;
  at: string;
}

export interface LoopbackTarget {
  /** Address the server is listening on (the socket the triggering request arrived on). */
  host: string;
  port: number;
  /** The server's own Bearer token. */
  authToken: string;
  /** Request timeout; default 10s. */
  timeoutMs?: number;
}

const DETAIL_MAX = 300;

/**
 * The only requests the privileged client will make (review r1 §7 containment).
 * A definition naming anything else is `not-applied`, never sent.
 */
export const ALLOWED_FEATURE_ACTIONS: ReadonlySet<string> = new Set([
  'PATCH /config',
  'PATCH /api/files/config',
  'POST /telemetry/enable',
  'POST /telemetry/disable',
]);

function clamp(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_MAX ? flat.slice(0, DETAIL_MAX - 1) + '…' : flat;
}

/** Map a socket's local address to one a loopback client can dial. */
export function loopbackHost(localAddress: string | undefined): string {
  if (!localAddress) return '127.0.0.1';
  let a = localAddress;
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4-mapped IPv6
  if (a === '0.0.0.0') return '127.0.0.1';
  if (a === '::') return '::1';
  return a;
}

function errorText(raw: string): string {
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === 'object') {
      const e = (j as Record<string, unknown>).error;
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string') {
        return (e as Record<string, unknown>).message as string;
      }
    }
  } catch { /* @silent-fallback-ok — non-JSON body, use raw text */ }
  return raw;
}

export function notApplied(direction: 'enable' | 'disable', detail: string): FeatureApplyResult {
  return { direction, outcome: 'not-applied', httpStatus: null, detail, at: new Date().toISOString() };
}

/**
 * Send one action to the server's own route and classify the answer.
 * Never throws.
 */
export function applyFeatureAction(
  action: EnableAction | undefined,
  direction: 'enable' | 'disable',
  target: LoopbackTarget,
): Promise<FeatureApplyResult> {
  const at = () => new Date().toISOString();
  if (!action || typeof action.path !== 'string' || !ALLOWED_FEATURE_ACTIONS.has(`${action.method} ${action.path}`)) {
    return Promise.resolve(notApplied(direction, 'this feature has no valid setting change defined'));
  }
  if (!target.authToken) {
    return Promise.resolve(notApplied(direction, 'the server has no auth token to make the setting change with'));
  }

  const payload = JSON.stringify(action.body ?? {});
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: FeatureApplyResult) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request({
      host: target.host,
      port: target.port,
      method: action.method,
      path: action.path,
      headers: {
        'Authorization': `Bearer ${target.authToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // Required by PATCH /api/files/config (CSRF intent header); harmless elsewhere.
        'X-Instar-Request': '1',
      },
      timeout: target.timeoutMs ?? 10_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { if (chunks.reduce((n, b) => n + b.length, 0) < 16_384) chunks.push(c); });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString('utf-8');
        if (status >= 200 && status < 300) {
          done({ direction, outcome: 'applied', httpStatus: status, detail: null, at: at() });
        } else if (status >= 300 && status < 400) {
          // http.request never follows a redirect; a route that answers one did not apply.
          done({ direction, outcome: 'failed', httpStatus: status, detail: 'the route answered a redirect, which is not followed', at: at() });
        } else if (status >= 400 && status < 500) {
          done({ direction, outcome: 'refused', httpStatus: status, detail: clamp(errorText(body) || `HTTP ${status}`), at: at() });
        } else {
          done({ direction, outcome: 'failed', httpStatus: status, detail: clamp(errorText(body) || `HTTP ${status}`), at: at() });
        }
      });
      res.on('error', (err) => done({ direction, outcome: 'failed', httpStatus: res.statusCode ?? null, detail: clamp(err.message), at: at() }));
    });
    req.on('timeout', () => {
      req.destroy();
      done({ direction, outcome: 'failed', httpStatus: null, detail: 'the setting change timed out; it may still land — the shown state re-reads the setting', at: at() });
    });
    req.on('error', (err) => done({ direction, outcome: 'failed', httpStatus: null, detail: clamp(err.message), at: at() }));
    req.end(payload);
  });
}
