// message-origin-all-platforms §2: which machine, harness and model wrote a reply that
// arrived through an app or Slack reply route. Evidence only: nothing here refuses a reply.
import {
  originEvidenceFromLaunchRecord, originEvidenceFromProducer, originEvidenceWithoutSession, type MessageOriginEvidence,
} from '../messaging/messageOrigin.js';
import type { TelegramOriginProducer } from '../messaging/telegram-origin/types.js';
import { MachineIdentityManager } from '../core/MachineIdentity.js';

/**
 * This machine's id and display name from its identity registry (the same source the Telegram
 * origin footer uses), cached for a minute. Unknown when the machine has no identity yet.
 */
export function localMachineIdentity(stateDir: string, now: () => number = Date.now): () => { id: string | null; name: string | null } {
  let cached: { id: string | null; name: string | null } | null = null;
  let at = 0;
  return () => {
    if (cached && now() - at < 60_000) return cached;
    try {
      const manager = new MachineIdentityManager(stateDir);
      if (manager.hasIdentity()) {
        const id = manager.loadIdentity().machineId;
        cached = { id, name: manager.loadRegistry().machines[id]?.nickname ?? null };
      } else cached = { id: null, name: null };
    } catch { cached = { id: null, name: null }; } // @silent-fallback-ok — an unreadable identity is recorded as an unknown machine
    at = now();
    return cached;
  };
}

export interface ReplyOriginDeps {
  /** This machine's id and display name (the identity registry nickname), or null when unknown. */
  machine: () => { id: string | null; name: string | null };
  /** The Telegram origin service, when its runtime booted (Telegram configured). */
  originService?: () => { sessionProducer(token: string): Promise<TelegramOriginProducer> } | null | undefined;
  /** The state record behind a tmux session name, when it is running on this machine. */
  runningSessionByTmux: (tmuxName: string) => { id: string; framework?: string | null; model?: string | null } | null;
  /** The state record id → its tmux name (to check that a credential belongs to the bound session). */
  tmuxForSessionId: (sessionId: string) => string | null;
  now?: () => number;
}

/** `boundBy` from verifyConversationBind (`session:<tmuxName>`), or null for a route with no bind token. */
export function boundSessionName(boundBy: string | undefined | null): string | null {
  if (typeof boundBy !== 'string' || !boundBy.startsWith('session:')) return null;
  const name = boundBy.slice('session:'.length);
  return name.length > 0 && name.length <= 256 ? name : null;
}

export async function resolveReplyOrigin(deps: ReplyOriginDeps, input: {
  /** The session the verified bind token names; null when the route has no bind token. */
  boundSession: string | null;
  /** The raw X-Instar-Origin-Session header value, if any. */
  originCredential: unknown;
}): Promise<MessageOriginEvidence> {
  const at = deps.now?.() ?? Date.now();
  let machine: { id: string | null; name: string | null } = { id: null, name: null };
  try { machine = deps.machine(); } catch { /* @silent-fallback-ok — an unreadable identity records an unknown machine */ }
  try { return await ladder(deps, input, at, machine); }
  catch { /* @silent-fallback-ok — evidence is never a reason to refuse a reply (§2) */ }
  return originEvidenceWithoutSession({ machineId: machine.id, machineName: machine.name, at, kind: 'unknown' });
}

/** The credential lookup may refresh a transcript observation; it is bounded so a reply never waits on it. */
const CREDENTIAL_BUDGET_MS = 1_500;

async function ladder(deps: ReplyOriginDeps, input: { boundSession: string | null; originCredential: unknown },
  at: number, machine: { id: string | null; name: string | null }): Promise<MessageOriginEvidence> {
  const credential = typeof input.originCredential === 'string' && /^ior1_[A-Za-z0-9_-]{43}$/.test(input.originCredential)
    ? input.originCredential : null;
  // Rung 1: a verified origin credential, accepted only for the bound session (or, on the legacy
  // raw-destination route with no bind token, on its own).
  if (credential) {
    try {
      const service = deps.originService?.();
      if (service) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const producer = await Promise.race([
          service.sessionProducer(credential),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('origin-credential-budget')), CREDENTIAL_BUDGET_MS); }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        const owner = producer.sessionId ? deps.tmuxForSessionId(producer.sessionId) : null;
        if (input.boundSession === null || (owner !== null && owner === input.boundSession)) {
          // The producer names this same machine; record it under the id the caller's store uses.
          const evidence = originEvidenceFromProducer(producer, at);
          return machine.id ? { ...evidence, machineId: machine.id } : evidence;
        }
      }
    } catch { /* @silent-fallback-ok — an unverifiable credential falls to the launch record (§2), never a refusal */ }
  }
  // Rung 2: the bound session's own launch record (configured, not observed).
  if (input.boundSession) {
    const session = deps.runningSessionByTmux(input.boundSession);
    if (session) {
      return originEvidenceFromLaunchRecord({ machineId: machine.id, machineName: machine.name, sessionId: session.id,
        framework: session.framework ?? null, model: session.model ?? null, at });
    }
  }
  // Rung 3: no session evidence.
  return originEvidenceWithoutSession({ machineId: machine.id, machineName: machine.name, at, kind: 'unknown' });
}
