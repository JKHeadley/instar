/**
 * Reads a Slack conversation's history from the machine that holds it, for the owner's phone
 * (docs/specs/mobile-slack-holder-proxy.md). A Slack id is local to the machine that minted it, and
 * a phone is signed for one host, so without this a row held elsewhere ends at 409 wrong-machine.
 *
 * The holder comes only from the trusted peer list, never from the request. The exact negative id
 * and machine are forwarded and never looked up here. One read, GET only: sends are never proxied.
 * The caller checks the phone before the call; `stillOwner` is checked again after the holder
 * answers, so a phone revoked mid-read gets nothing.
 */
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from './peerUrlGuard.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { poolPeerFetch, PoolPeerAdmissionError, type PoolPeerTarget, type RopeResultRecorder } from './poolPeerFetch.js';

export const HOLDER_READ_TIMEOUT_MS = 8_000;
export const HOLDER_READ_MAX_BYTES = 4 * 1024 * 1024;
export const HOLDER_READ_MAX_IN_FLIGHT = 8;
/** Per holder, so one dead machine cannot take every slot. */
export const HOLDER_READ_MAX_PER_HOLDER = 4;
const BEFORE_MAX_CHARS = 300;
/** The holder's own refusals a phone can act on; any other failure reads as the holder failing. */
const PASSED_REFUSALS = new Set(['unknown-conversation', 'slack-not-configured', 'slack-owner-unset', 'native-conversations-off']);

export interface HolderReadRequest {
  id: number;
  machine: string;
  limit: number;
  before: string | null;
  stillOwner: () => boolean;
}
export interface HolderReadAnswer { status: number; body: Record<string, unknown> }
export type HolderRead = (request: HolderReadRequest) => Promise<HolderReadAnswer>;

export interface HolderReadDeps {
  peers: () => PoolPeerTarget[];
  allowlist?: () => readonly string[] | undefined;
  token: () => string | undefined;
  selfMachineId: () => string;
  record?: RopeResultRecorder;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** The body up to `max` bytes, or null once it goes past. The read stops there. */
async function boundedText(response: Response, max: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return null; } // @silent-fallback-ok — releasing an oversized body; the read is already refused
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function reportFailure(reason: string): void {
  try {
    DegradationReporter.getInstance().report({
      feature: 'MobileSlackHolderProxy.read',
      primary: 'the owner\'s phone reads Slack history from the machine that holds it',
      fallback: 'the phone says the holder could not answer and the owner can retry',
      reason,
      impact: 'This Slack conversation cannot be opened from the phone until the holder answers.',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn a refusal into a crash */ }
}

const failed = (status: number, error: string, detail = 'The machine that holds this Slack conversation could not answer. Try again.'): HolderReadAnswer => {
  reportFailure(error);
  return { status, body: { error, detail } };
};

export function buildSlackHolderRead(deps: HolderReadDeps): HolderRead {
  let inFlight = 0;
  const perHolder = new Map<string, number>();
  return async (q) => {
    const peer = deps.peers().find((p) => p.machineId === q.machine);
    if (!peer) return { status: 409, body: { error: 'wrong-machine', servedBy: deps.selfMachineId(), detail: 'This Slack conversation belongs to a machine this one does not know.' } };
    if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: (peer.kind ?? 'last-known-url') as PeerEndpointKind }, deps.allowlist?.()).ok) return failed(502, 'holder-url-refused');
    const token = deps.token();
    if (!token) return failed(503, 'holder-unavailable');
    if (q.before !== null && q.before.length > BEFORE_MAX_CHARS) return { status: 400, body: { error: 'bad-before' } };
    const mine = perHolder.get(q.machine) ?? 0;
    if (inFlight >= HOLDER_READ_MAX_IN_FLIGHT || mine >= HOLDER_READ_MAX_PER_HOLDER) return failed(503, 'holder-busy');
    inFlight++;
    perHolder.set(q.machine, mine + 1);
    try {
      const before = q.before === null ? '' : `&before=${encodeURIComponent(q.before)}`;
      const path = `/mobile/chat/slack/${q.id}/messages?machine=${encodeURIComponent(q.machine)}&limit=${q.limit}&deviceView=1${before}`;
      const ownerFetch: typeof fetch = async (input, init) => {
        if (!q.stillOwner()) throw new PoolPeerAdmissionError('owner-phone-required');
        return (deps.fetchImpl ?? fetch)(input, init);
      };
      const r = await poolPeerFetch(deps.record, peer, path, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(deps.timeoutMs ?? HOLDER_READ_TIMEOUT_MS),
      }, ownerFetch);
      if (r.status >= 300 && r.status < 400) { await r.body?.cancel().catch(() => undefined); return failed(502, 'holder-redirected'); } // @silent-fallback-ok — releasing a refused redirect's body
      const text = await boundedText(r, deps.maxBytes ?? HOLDER_READ_MAX_BYTES);
      if (text === null) return failed(502, 'holder-too-large');
      let body: Record<string, unknown> | null = null;
      try { const parsed: unknown = JSON.parse(text); body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { body = null; } // @silent-fallback-ok — an unreadable answer is refused just below
      // Private bytes go back only to a phone that is still the owner's, read after the wait.
      if (!q.stillOwner()) return { status: 403, body: { error: 'owner-only', detail: 'Only the agent\'s owner can use Slack from the app.' } };
      if (!r.ok) {
        const code = typeof body?.error === 'string' ? body.error : '';
        return PASSED_REFUSALS.has(code) ? { status: r.status, body: { error: code } } : failed(502, 'holder-failed');
      }
      // `deviceView` proves a holder new enough to answer in the phone's shape; an older holder's
      // token read carries server paths, so it is refused rather than passed on.
      if (!body || body.conversationId !== q.id || !Array.isArray(body.messages)) return failed(502, 'holder-bad-answer');
      if (body.deviceView !== true) return failed(502, 'holder-outdated', 'The machine that holds this Slack conversation needs updating before the phone can read it.');
      const { deviceView: _shape, ...answer } = body;
      if (!q.stillOwner()) return { status: 403, body: { error: 'owner-only', detail: 'Only the agent\'s owner can use Slack from the app.' } };
      return { status: 200, body: answer };
    } catch (err) {
      if (err instanceof PoolPeerAdmissionError) return { status: 403, body: { error: 'owner-only', detail: 'Only the agent\'s owner can use Slack from the app.' } };
      const name = (err as { name?: string } | null)?.name;
      return failed(name === 'TimeoutError' || name === 'AbortError' ? 504 : 502, name === 'TimeoutError' || name === 'AbortError' ? 'holder-timeout' : 'holder-unreachable'); // @silent-fallback-ok — the failure is the answer the phone gets
    } finally {
      inFlight--;
      const left = (perHolder.get(q.machine) ?? 1) - 1;
      if (left > 0) perHolder.set(q.machine, left); else perHolder.delete(q.machine);
    }
  };
}
