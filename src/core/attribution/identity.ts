/**
 * Who a platform id belongs to. Spec section 2. Registered users first, then the owner through
 * the existing resolvers, which refuse ambiguity. A logged display name alone never maps, and a
 * second verified operator is not the owner. A channel with no owner id on file reads
 * `identity-unverified` until one exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolvePeerFingerprint } from '../../threadline/peerFingerprint.js';
import { resolveApprovalOwner } from '../../threadline/PairingInviteTelegram.js';
import { readPairingOwnerName } from '../../threadline/pairingOwnerName.js';
import { TopicOperatorStore } from '../../users/TopicOperatorStore.js';
import type { UserManager } from '../../users/UserManager.js';
import { APP_OWNER_ID, type IdentityMap } from './recordEligibility.js';

export interface IdentityDeps {
  stateDir: string;
  users?: () => UserManager | null | undefined;
  /** The configured Telegram owner id, when this agent has one. */
  configuredOwnerUid?: () => unknown;
  /** `mobilePairing.slackOwnerUserId`. */
  slackOwnerUserId?: () => string | null | undefined;
  now?: () => number;
}

interface OwnerFacts { uid: number | undefined; name: string }

const OWNER_TTL_MS = 30_000;

export class AttributionIdentity {
  private owner: { at: number; facts: OwnerFacts } | null = null;

  constructor(private readonly deps: IdentityDeps) {}

  readonly map: IdentityMap = (channel, platformId) => {
    const users = this.deps.users?.() ?? null;
    switch (channel) {
      case 'telegram': {
        const id = Number(platformId);
        if (!Number.isSafeInteger(id)) return null;
        const registered = users?.resolveFromTelegramUserId(id);
        if (registered) return registered.name;
        const owner = this.ownerFacts();
        return owner.uid === id && owner.name ? owner.name : null;
      }
      case 'slack': {
        const registered = users?.resolveFromSlackUserId(platformId);
        if (registered) return registered.name;
        const owner = this.deps.slackOwnerUserId?.();
        return owner && owner === platformId ? this.ownerFacts().name || null : null;
      }
      case 'imessage':
      case 'whatsapp':
        return users?.resolveFromChannel({ type: channel, identifier: platformId })?.name ?? null;
      case 'app':
        if (platformId === APP_OWNER_ID) return this.ownerFacts().name || null;
        return users?.getUser(platformId)?.name ?? null;
      case 'threadline':
        return this.knownAgentName(platformId);
    }
  };

  /** Names the send record's filter looks for. Only ever a hint. */
  knownPeople(): string[] {
    const names = new Set<string>();
    const owner = this.ownerFacts().name;
    if (owner) names.add(owner.split(/\s+/)[0]);
    for (const user of this.deps.users?.()?.listUsers() ?? []) if (user.name) names.add(user.name.split(/\s+/)[0]);
    return [...names];
  }

  private ownerFacts(): OwnerFacts {
    const now = this.deps.now?.() ?? Date.now();
    if (this.owner && now - this.owner.at < OWNER_TTL_MS) return this.owner.facts;
    const configured = this.deps.configuredOwnerUid?.();
    let facts: OwnerFacts = { uid: undefined, name: '' };
    try {
      const operators = new TopicOperatorStore(path.join(this.deps.stateDir, 'state'));
      facts = {
        uid: resolveApprovalOwner(configured, Object.values(operators.allBindings()), operators.everVerifiedOperatorUids()),
        name: readPairingOwnerName(this.deps.stateDir, this.deps.users?.()?.listUsers() ?? [], configured),
      };
    } catch {
      // @silent-fallback-ok — an unreadable operator store names no owner, which reads identity-unverified.
    }
    this.owner = { at: now, facts };
    return facts;
  }

  private knownAgentName(fingerprint: string): string | null {
    try {
      const file = path.join(this.deps.stateDir, 'threadline', 'known-agents.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { agents?: unknown } | unknown[];
      const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { agents?: unknown }).agents) ? (parsed as { agents: unknown[] }).agents : [];
      for (const agent of list as Array<{ name?: string; publicKey?: string; fingerprint?: string }>) {
        if (agent?.name && resolvePeerFingerprint(agent) === fingerprint.toLowerCase()) return agent.name;
      }
    } catch {
      // @silent-fallback-ok — no known-agents file names nobody, which reads identity-unverified.
    }
    return null;
  }
}
