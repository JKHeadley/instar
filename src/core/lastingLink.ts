/**
 * Whether two machines have a connection that survives a restart
 * (docs/specs/session-pool-takeover-at-pairing.md).
 *
 * A quick tunnel gets a new address at every restart. With no git remote there is then no
 * way to announce it, so two machines joined only that way lose each other for good. A
 * machine in that state cannot tell a dead peer from a lost one, so it must not keep a lease
 * alongside it: both would run jobs and poll Telegram with nothing to end it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateMeshEndpoints } from './MeshEndpointValidator.js';
import { hostOf } from './PeerEndpointResolver.js';
import type { MeshEndpoint } from './types.js';

export function isLastingEndpoint(kind: MeshEndpoint['kind'], url: string): boolean {
  if (kind !== 'cloudflare') return true;
  const host = hostOf(url);
  return !!host && !host.endsWith('.trycloudflare.com');
}

/** The untrusted set a peer sent, cleaned, without any address that dies at a restart. */
export function lastingEndpoints(raw: unknown): MeshEndpoint[] {
  return validateMeshEndpoints(raw).filter((e) => isLastingEndpoint(e.kind, e.url));
}

/**
 * Incoming first, then whatever else was already known: a re-pair must not wipe an address that
 * was found to work, and a stale one only costs a failed dial.
 */
export function mergeEndpoints(existing: readonly MeshEndpoint[] | undefined, incoming: readonly MeshEndpoint[]): MeshEndpoint[] {
  const seen = new Set(incoming.map((e) => e.url));
  return [...incoming, ...(existing ?? []).filter((e) => !seen.has(e.url))];
}

type Proof = { kind: MeshEndpoint['kind']; at: string };

/**
 * Durable, because the moment proof is needed the peer is gone. Read from disk each time: the
 * file is tiny, and a pairing route in this same process can clear a row.
 */
export class LastingLinkLedger {
  private readonly file: string;

  constructor(stateDir: string, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(stateDir, 'state', 'lasting-link.json');
  }

  private load(): Record<string, Proof> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'))?.peers;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // @silent-fallback-ok: no readable proof holds takeover back, which is the safe side.
      return {};
    }
  }

  private save(peers: Record<string, Proof>): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ peers }, null, 2));
      fs.renameSync(temp, this.file);
    } catch (err) {
      // The next signed exchange tries again; until then this machine does not hold on proof.
      console.warn('[lasting-link] could not save proof:', err);
    }
  }

  provenWith(peerMachineId: string): boolean {
    return Object.hasOwn(this.load(), peerMachineId);
  }

  record(peerMachineId: string, kind: MeshEndpoint['kind'], url: string): void {
    if (!isLastingEndpoint(kind, url)) return;
    const peers = this.load();
    if (Object.hasOwn(peers, peerMachineId)) return;
    this.save({ ...peers, [peerMachineId]: { kind, at: this.now().toISOString() } });
  }

  /** A pairing starts over: the old proof may be for keys or a network that are gone. */
  forget(peerMachineId: string): void {
    const peers = this.load();
    if (!Object.hasOwn(peers, peerMachineId)) return;
    delete peers[peerMachineId];
    this.save(peers);
  }
}

/** What a machine knows when deciding whether it must wait for proof of a lasting link. */
export interface LastingLinkInputs {
  enabled: boolean;
  requireLastingLink: boolean;
  preferredNamed: boolean;
  /** The machine this one first paired with. A third machine's proof says nothing about reaching it. */
  pairedWith?: string;
  livePeerIds: readonly string[];
  provenWith: (peerMachineId: string) => boolean;
}

/**
 * True while the first pairing's partner is live and unproved. Once that partner is revoked there
 * is nothing left to be split from. A machine added later never holds this up, because a replacement
 * must not stop the only working machine.
 */
export function lastingLinkUnproved(i: LastingLinkInputs): boolean {
  if (!i.enabled || !i.requireLastingLink || i.preferredNamed) return false;
  if (!i.pairedWith) return i.livePeerIds.some((id) => !i.provenWith(id)); // Should not happen: the safe side.
  return i.livePeerIds.includes(i.pairedWith) && !i.provenWith(i.pairedWith);
}
