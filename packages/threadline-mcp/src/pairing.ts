/**
 * Verified pairing, end-to-end encryption and the credential gate for threadline-mcp, with no
 * Instar (spec docs/specs/threadline-standalone-pairing.md, principle D0).
 *
 * Everything security-relevant comes from `threadline-core`, the same code Instar runs, so a
 * threadline-mcp agent and an Instar agent pair with each other and exchange encrypted messages.
 * This module has no MCP SDK import: the tools in server.ts call it, and tests drive it directly.
 *
 * Wire compatibility with Instar 1.3.1352+:
 *  - `pair-invite-accept` goes PLAINTEXT: payload = base64(JSON{ text: JSON(payload), type: op }).
 *  - `pair-invite-used|finish|ack` and every message to a pinned peer go ENCRYPTED to the pinned
 *    key: PlaintextMessage{ content, type, ...payload } in a signed envelope.
 * Rules: a peer with a pinned key never gets plaintext, and an encrypted message is only ever
 * decrypted with a PINNED key. A credential needs a mutual-verified pin bound to our current key.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  EnvelopeCrypto, PairingInviteFlow, PairingInviteStore, PinnedKeyStore, INVITE_OPS, OP_ACCEPT,
  canonicalizeEnvelope, classifyInviteText, credentialAcceptFrom, credentialSendKey, edPublicToX25519, verify, PINNED_KEYS_FILE,
  type InviteEvent, type MessageEnvelope, type PlaintextMessage,
} from '@sagemindai/threadline-core';

export interface StandaloneIdentity {
  /** 32 hex chars: the first 16 bytes of the public key. */
  fp: string;
  publicKey: Buffer;
  /** The 32-byte Ed25519 seed. */
  privateKey: Buffer;
}

/** A relay envelope as it arrives: encrypted (signature, ephemeralPubKey) or plaintext. */
export type WireEnvelope = Partial<MessageEnvelope> & { from: string; to?: string; threadId?: string; messageId?: string; payload?: string; timestamp?: string };

export interface StandaloneDeps {
  stateDir: string;
  identity: StandaloneIdentity;
  ownName: () => { owner: string; agent: string };
  /** Put one envelope on the relay socket. */
  sendEnvelope: (envelope: Record<string, unknown>) => void;
  /** HTTP base of the relay (for the public a2a card), or null to skip the relay-key check. */
  relayHttpBase: string | null;
  now?: () => Date;
  /**
   * False when another threadline-mcp owns pairing for this state directory (see stateLock.ts). A function
   * is read live, so an instance that takes ownership later (the owner exited) acts as owner from then on;
   * call becomeOwner() at that moment so the stores are re-read from disk.
   */
  ownsPairing?: boolean | (() => boolean);
  /**
   * One attempt to take pairing ownership (the owner may have exited), made before an inbound pairing op
   * is decided, so the other side's accept or finish is not refused just because no tool call came first.
   * Returns whether this instance owns pairing now. Defaults to the ownsPairing check.
   */
  claimOwnership?: () => boolean;
  fetchImpl?: typeof fetch;
}

/** What an incoming envelope turned out to be. */
export type Inbound =
  | { kind: 'control' }                                   // a pairing op, handled here, never shown to the model
  | { kind: 'message'; text: string; type?: string; encrypted: boolean; credential: boolean; fromPairedPeer?: boolean; unverifiedPairedClaim?: boolean }
  | { kind: 'refused'; reason: string };                  // e.g. an encrypted message from an unpinned sender

export interface StandaloneEvent { at: string; event: InviteEvent }

export const INVITE_IN_MESSAGE = 'invite-in-message';

/** One plain line per pairing event, for the inbox (spec §4: system lines, not agent messages). */
export function describePairingEvent(e: InviteEvent): string {
  switch (e.kind) {
    case 'accept-prompt': return `Pairing: you were invited by the agent that calls itself "${e.claimedAgent}". Your person decides with threadline_pair_open.`;
    case 'finish-prompt': return `Pairing: the agent that calls itself "${e.claimedAgent}" accepted your invite. Run threadline_pair_finish so your person can confirm it is who they sent it to.`;
    case 'paired': return `Pairing: you are now paired with "${e.claimedAgent}". Messages to it are always encrypted, and it can receive credentials.`;
    case 'second-accept-alarm': return `Pairing WARNING: a second agent ("${e.lateClaimedAgent}") used the same invite, so it leaked. The first pairing is paused. Tell your person.`;
    case 'invite-used-elsewhere': return 'Pairing: the invite you accepted had already been used by someone else, so it did not pair. Ask for a new one.';
  }
}

export class StandalonePairing {
  // Replaced (re-read from disk) by becomeOwner(); read them through the instance, never cache them.
  flow!: PairingInviteFlow;
  keys!: PinnedKeyStore;
  invites!: PairingInviteStore;
  readonly events = new EventEmitter();
  private crypto!: EnvelopeCrypto;
  private readonly recent: StandaloneEvent[] = [];
  /** Store files set aside this run (unparseable): an attention item in status and the inbox. */
  readonly storeProblems: Array<{ at: string; message: string }> = [];
  /** Things the person should know that are not store problems (an invite seen inside a message). */
  readonly alarms: Array<{ at: string; message: string }> = [];
  /** Plaintext refused this run because its sender had spoken encrypted before (spec D6), by fingerprint. */
  readonly refusedPlaintext = new Map<string, number>();
  /** Encrypted messages already accepted, by sender and messageId, so a captured envelope cannot be replayed. In memory, bounded. */
  private readonly seen = new Set<string>();
  static readonly SEEN_MAX = 10_000;
  /** A credential older than this, or dated this far in the future, is refused (a relay replaying a captured one). */
  static readonly CREDENTIAL_MAX_AGE_MS = 60 * 60_000;
  static readonly CREDENTIAL_MAX_SKEW_MS = 10 * 60_000;
  private seenLines = 0;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  /** Append-only record of pairing events, refusals and credential sends (never content or secrets). 0600, rotated at 1 MB. */
  readonly auditPath: string;
  static readonly AUDIT_MAX_BYTES = 1_000_000;

  constructor(private readonly deps: StandaloneDeps) {
    this.now = deps.now ?? (() => new Date());
    this.auditPath = path.join(deps.stateDir, 'threadline', 'pairing-audit.jsonl');
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.crypto = new EnvelopeCrypto(deps.identity.privateKey, deps.identity.publicKey);
    this.loadStores();
  }

  /** Does this instance own pairing right now? */
  /** Before deciding an inbound pairing op: try to take ownership if the owner has gone. */
  private claim(): boolean {
    return this.deps.claimOwnership ? this.deps.claimOwnership() : this.owns();
  }

  private owns(): boolean {
    const o = this.deps.ownsPairing;
    return typeof o === 'function' ? o() : o !== false;
  }

  /**
   * This instance just took ownership (the previous owner exited): re-read pins, invites and the replay
   * ledger from disk, and run the owner-only migration, so it continues from the owner's last state.
   */
  becomeOwner(): void {
    this.loadStores();
  }

  /** Bumped on each reload; a replaced flow's pending Finish retries see a stale generation and do nothing. */
  private flowGen = 0;

  private loadStores(): void {
    const deps = this.deps;
    const gen = ++this.flowGen;
    // A store file that could not be parsed is set aside by threadline-core; the person must see that.
    const report = (message: string) => {
      this.storeProblems.push({ at: this.now().toISOString(), message });
      this.audit({ kind: 'store-problem', message });
      process.stderr.write(`[threadline-mcp] ${message}\n`);
    };
    this.keys = new PinnedKeyStore(deps.stateDir, this.now, report);
    this.invites = new PairingInviteStore(deps.stateDir, this.now, report);
    this.loadSeen();
    this.migrateLegacyEncryptedPeers();
    this.flow = new PairingInviteFlow({
      store: this.invites,
      trust: this.keys,
      identity: () => ({ fp: deps.identity.fp, publicKeyHex: deps.identity.publicKey.toString('hex'), privateKey: deps.identity.privateKey }),
      relayKeyFor: (fp) => this.relayKeyFor(fp),
      sendPlaintext: (to, op, payload) => this.sendPlaintextTyped(to, op, JSON.stringify(payload)),
      sendToKey: (to, keyHex, op, payload) => this.sendEncrypted(to, Buffer.from(keyHex, 'hex'), { content: op, type: op, ...payload } as PlaintextMessage),
      notify: (event) => { this.recent.unshift({ at: this.now().toISOString(), event }); this.recent.splice(50); this.audit({ ...event }); this.events.emit('event', event); },
      ownName: deps.ownName,
      now: this.now,
      // Disposal: when becomeOwner() replaces this flow, its scheduled Finish retries become no-ops.
      schedule: (fn, ms) => { setTimeout(() => { if (gen === this.flowGen) fn(); }, ms).unref?.(); },
    });
  }

  /** Pins as they are on disk now: a non-owner re-reads them so a pairing the owner just made is honoured. */
  private readKeys(): PinnedKeyStore {
    return !this.owns() ? new PinnedKeyStore(this.deps.stateDir, this.now, () => {}) : this.keys;
  }

  /** An accepted pairing whose Finish never came: older than the longest invite lifetime plus 10 minutes. */
  finishOverdue(pin: { pairingState?: string; via?: string }): boolean {
    if (pin.pairingState !== 'invite-accepted' || String(pin.via ?? '').startsWith('paused:')) return false;
    const since = Date.parse(String((pin as { updatedAt?: string }).updatedAt ?? ''));
    return !Number.isNaN(since) && this.now().getTime() - since > StandalonePairing.FINISH_WAIT_MS;
  }
  static readonly FINISH_WAIT_MS = 24 * 60 * 60_000 + 10 * 60_000;

  private seenFile(): string { return path.join(this.deps.stateDir, 'threadline', 'seen-messages.jsonl'); }

  /** Load the replay ledger (last SEEN_MAX ids). */
  private loadSeen(): void {
    try {
      const lines = fs.readFileSync(this.seenFile(), 'utf8').split('\n').filter(Boolean);
      this.seenLines = lines.length;
      for (const l of lines.slice(-StandalonePairing.SEEN_MAX)) this.seen.add(l);
    } catch { /* no ledger yet */ }
  }

  private rememberSeen(id: string): void {
    this.seen.add(id);
    if (this.seen.size > StandalonePairing.SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    try {
      const file = this.seenFile();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, id + '\n', { mode: 0o600 });
      if (++this.seenLines > 2 * StandalonePairing.SEEN_MAX) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, [...this.seen].join('\n') + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        this.seenLines = this.seen.size;
      }
    } catch { /* the in-memory ledger still refuses replays this run */ }
  }

  /**
   * The downgrade high-water mark (spec D6) lives in the pin record (`encryptedSeenAt`), so it is
   * created with the pin and removed only when the person forgets the pin. 0.5.0 builds before r3
   * kept it in `encrypted-chat-peers.json`; the owner folds that file into the pins once.
   */
  private legacyEncryptedPeersFile(): string { return path.join(this.deps.stateDir, 'threadline', 'encrypted-chat-peers.json'); }
  /** True when the legacy mark file existed but could not be read: every pinned peer is then treated as seen. */
  private legacyMarkUnreadable = false;

  private migrateLegacyEncryptedPeers(): void {
    const file = this.legacyEncryptedPeersFile();
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.legacyMarkUnreadable = true;
      return;
    }
    let all: Record<string, unknown>;
    try { all = JSON.parse(text); if (!all || typeof all !== 'object') throw new Error('not an object'); } catch { this.legacyMarkUnreadable = true; return; }
    if (!this.owns()) return; // only the owner writes pairing state; the file is still honoured below
    for (const fp of Object.keys(all)) this.keys.markEncryptedSeen(fp);
    try { fs.renameSync(file, `${file}.migrated`); } catch { /* honoured from the pins either way */ }
    this.audit({ kind: 'encrypted-chat-marks-migrated', count: Object.keys(all).length });
  }

  /** Is the pinned-keys store itself set aside this run? Then no pin is trustworthy, in either direction. */
  private pinStoreBroken(): boolean {
    return this.storeProblems.some((p) => p.message.includes(PINNED_KEYS_FILE));
  }

  /**
   * Has this pinned peer sent us encrypted chat? Fail safe: if the legacy mark file could not be
   * read, every pinned peer counts as seen (plaintext in its name is refused), and status says so.
   */
  encryptedChatSeen(fp: string): boolean {
    if (this.legacyMarkUnreadable) {
      if (!this.storeProblems.some((p) => p.message.includes('encrypted-chat-peers.json'))) {
        const message = `${this.legacyEncryptedPeersFile()} could not be read, so every paired agent is treated as having sent encrypted chat (plaintext in their name is refused) until it is repaired or removed.`;
        this.storeProblems.push({ at: this.now().toISOString(), message });
        this.audit({ kind: 'store-problem', message });
      }
      return true;
    }
    if (!this.owns()) {
      // A non-owner has not migrated the legacy file; honour it alongside the pins.
      try { const all = JSON.parse(fs.readFileSync(this.legacyEncryptedPeersFile(), 'utf8')); if (all && all[fp.toLowerCase()]) return true; } catch { /* absent */ }
    }
    return Boolean(this.readKeys().getProfileByFingerprint(fp)?.encryptedSeenAt);
  }

  private markEncryptedChat(fp: string): void {
    const before = this.keys.getProfileByFingerprint(fp)?.encryptedSeenAt;
    if (before || this.legacyMarkUnreadable) return;
    if (this.keys.markEncryptedSeen(fp)) this.audit({ kind: 'encrypted-chat-first-seen', from: fp });
  }

  /**
   * An invite arrived inside a message (spec D4). It is never shown to the model. The person is told,
   * because whoever saw it may try to use it: they should cancel it and send a fresh one privately.
   */
  private inviteLeak(from: string): Inbound {
    const message = `An agent (${from.slice(0, 8)}) sent a pairing invite inside a message. It was not shown to your agent. Invites should be pasted by a person into the pairing box, never relayed; if it is yours, cancel it and send a new one privately.`;
    this.alarms.push({ at: this.now().toISOString(), message });
    this.alarms.splice(0, Math.max(0, this.alarms.length - 20));
    this.audit({ kind: 'invite-leak-inbound', from });
    return { kind: 'refused', reason: 'a pairing invite arrived as a message; invites are pasted by a person, not relayed' };
  }

  /** Best effort: the audit must never break messaging. */
  private audit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true, mode: 0o700 });
      try { if (fs.statSync(this.auditPath).size > StandalonePairing.AUDIT_MAX_BYTES) fs.renameSync(this.auditPath, this.auditPath + '.1'); } catch { /* none yet */ }
      fs.appendFileSync(this.auditPath, JSON.stringify({ at: this.now().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch { /* unwritable state dir: messaging continues */ }
  }

  /** The key the relay's public card shows for `fp`, or null when it has none (spec: proceed). */
  async relayKeyFor(fp: string): Promise<string | null> {
    if (!this.deps.relayHttpBase || !/^[0-9a-f]{32}$/.test(fp)) return null;
    try {
      const res = await this.fetchImpl(`${this.deps.relayHttpBase}/v1/registry/agent/${fp}/a2a-card`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const card = (await res.json()) as { 'x-threadline'?: { publicKey?: unknown } };
      const b64 = card?.['x-threadline']?.publicKey;
      if (typeof b64 !== 'string') return null;
      const key = Buffer.from(b64, 'base64');
      return key.length === 32 && key.subarray(0, 16).toString('hex') === fp ? key.toString('hex') : null;
    } catch {
      return null;
    }
  }

  private sendPlaintextTyped(to: string, type: string, text: string, threadId?: string): string {
    const tid = threadId ?? `thread-${crypto.randomBytes(4).toString('hex')}`;
    this.deps.sendEnvelope({
      from: this.deps.identity.fp, to, threadId: tid, messageId: crypto.randomUUID(),
      timestamp: this.now().toISOString(), payload: Buffer.from(JSON.stringify({ text, type })).toString('base64'),
    });
    return tid;
  }

  private sendEncrypted(to: string, pinnedKey: Buffer, message: PlaintextMessage, threadId?: string): string {
    if (pinnedKey.length !== 32 || pinnedKey.subarray(0, 16).toString('hex') !== to.toLowerCase()) throw new Error('pinned key does not match the recipient');
    const tid = threadId ?? `thread-${crypto.randomBytes(4).toString('hex')}`;
    this.deps.sendEnvelope(this.crypto.encrypt(pinnedKey, edPublicToX25519(pinnedKey), tid, message) as unknown as Record<string, unknown>);
    return tid;
  }

  /**
   * Send an ordinary message. A paired peer is ALWAYS sent encrypted (never a silent downgrade);
   * an acceptor still waiting for the inviter's Finish sends as before pairing (see below). `credential: true` is refused unless the peer is mutual-verified and bound to our
   * current key, and then goes only to the key derived from the pin.
   */
  send(to: string, text: string, opts: { threadId?: string; credential?: boolean } = {}): { sent: true; threadId: string; encrypted: boolean } | { sent: false; reason: string } {
    const fp = to.toLowerCase();
    // An invite is handed over privately by a person, never relayed (spec D4): it works once,
    // and whoever sees it first is offered to the inviter's person.
    // Refused only for a token that decodes with a valid checksum; a look-alike is sent and logged.
    const inv = classifyInviteText(text);
    if (inv === 'valid') { this.audit({ kind: 'invite-send-refused', to: fp }); return { sent: false, reason: INVITE_IN_MESSAGE }; }
    if (inv === 'lookalike') this.audit({ kind: 'invite-lookalike-sent', to: fp });
    const keys = this.readKeys();
    if (opts.credential && !this.owns()) return { sent: false, reason: 'not-pairing-owner' };
    if (opts.credential) {
      const d = credentialSendKey(keys, fp, this.deps.identity.publicKey.toString('hex'));
      this.audit({ kind: d.allow ? 'credential-sent' : 'credential-refused', to: fp, ...(d.allow ? {} : { reason: d.reason }) });
      if (!d.allow) return { sent: false, reason: d.reason };
      return { sent: true, encrypted: true, threadId: this.sendEncrypted(fp, d.peerIdentityPub, { content: text, type: 'chat', metadata: { credential: true } }, opts.threadId) };
    }
    const pin = keys.getProfileByFingerprint(fp);
    // An acceptor whose pairing the inviter has not finished yet holds the inviter's key, but the
    // inviter does not hold ours yet: an encrypted message would be dropped as from an unknown
    // sender. Until the Finish arrives we send as before pairing. A pin PAUSED after a leaked
    // invite was verified on both sides, so the peer can still read it: that stays encrypted.
    const awaitingFinish = pin?.pairingState === 'invite-accepted' && !String(pin.via ?? '').startsWith('paused:');
    // That window has an end (Echo review SEC-6/ADV-7): past the longest an invite can live plus a
    // margin, the Finish is not coming. Refuse rather than keep sending plaintext indefinitely.
    if (awaitingFinish && this.finishOverdue(pin)) return { sent: false, reason: 'finish-not-received' };
    if (pin?.peerIdentityPub && !awaitingFinish) {
      return { sent: true, encrypted: true, threadId: this.sendEncrypted(fp, Buffer.from(pin.peerIdentityPub, 'hex'), { content: text, type: 'chat' }, opts.threadId) };
    }
    return { sent: true, encrypted: false, threadId: this.sendPlaintextTyped(fp, 'chat', text, opts.threadId) };
  }

  /** Classify an incoming envelope: pairing ops are handled here; encrypted ones need a pinned sender. */
  async receive(env: WireEnvelope): Promise<Inbound> {
    const r = await this.classify(env);
    if (r.kind === 'refused') this.audit({ kind: 'refused', from: String(env.from || '').toLowerCase(), reason: r.reason });
    else if (r.kind === 'message' && r.credential) this.audit({ kind: 'credential-received', from: String(env.from || '').toLowerCase() });
    return r;
  }

  private async classify(env: WireEnvelope): Promise<Inbound> {
    const from = String(env.from || '').toLowerCase();
    const keys = this.readKeys();
    if (env.signature && env.ephemeralPubKey) {
      const pin = keys.getProfileByFingerprint(from);
      if (!pin?.peerIdentityPub) return { kind: 'refused', reason: 'encrypted message from a sender with no pinned key' };
      let msg: PlaintextMessage;
      try {
        const key = Buffer.from(pin.peerIdentityPub, 'hex');
        msg = this.crypto.decrypt(env as MessageEnvelope, key, edPublicToX25519(key));
      } catch {
        return { kind: 'refused', reason: 'could not verify or decrypt with the pinned key' };
      }
      // Defence in depth: `to` is signed, and an envelope encrypted for another agent already fails to
      // decrypt with our key, so this only states the rule explicitly (Echo review SEC-3).
      if (String(env.to || '').toLowerCase() !== this.deps.identity.fp.toLowerCase()) return { kind: 'refused', reason: 'addressed to another agent' };
      // Recorded only AFTER verification, so a forged envelope cannot poison the ledger; persisted,
      // so a replay is refused after a restart too.
      const id = `${from}:${env.messageId || env.signature}`;
      if (this.seen.has(id)) return { kind: 'refused', reason: 'replayed message (already received)' };
      this.rememberSeen(id);
      if (msg.type && INVITE_OPS.has(msg.type)) {
        if (!this.claim()) return { kind: 'refused', reason: 'pairing message reached an instance that does not own pairing' };
        await this.flow.handleControl(msg.type, from, msg as unknown as Record<string, unknown>);
        return { kind: 'control' };
      }
      const credential = (msg.metadata as { credential?: unknown } | undefined)?.credential === true;
      if (credential && !credentialAcceptFrom(keys, from, this.deps.identity.publicKey.toString('hex'))) return { kind: 'refused', reason: 'credential from a peer that is not mutual-verified' };
      if (credential) {
        // The timestamp is signed. Ordinary chat may legitimately arrive late (queued while we were
        // offline); a credential may not, so a captured one cannot be replayed under a new messageId later.
        const ts = Date.parse(String(env.timestamp || ''));
        const age = this.now().getTime() - ts;
        if (Number.isNaN(ts) || age > StandalonePairing.CREDENTIAL_MAX_AGE_MS || age < -StandalonePairing.CREDENTIAL_MAX_SKEW_MS) {
          return { kind: 'refused', reason: 'credential outside its freshness window (possible replay)' };
        }
      }
      // The downgrade high-water mark: ordinary chat only. Pairing ops and credentials are always
      // encrypted, even from peers that still send ordinary chat in plaintext.
      if (!credential && this.owns()) this.markEncryptedChat(from);
      if (classifyInviteText(String(msg.content ?? '')) === 'valid') return this.inviteLeak(from);
      return { kind: 'message', text: String(msg.content ?? ''), type: msg.type, encrypted: true, credential };
    }
    // Plaintext.
    let text = String(env.payload ?? ''), type: string | undefined;
    try {
      const decoded = JSON.parse(Buffer.from(String(env.payload ?? ''), 'base64').toString('utf-8'));
      if (decoded && typeof decoded === 'object') { text = String(decoded.text ?? decoded.content ?? JSON.stringify(decoded)); type = decoded.type; }
    } catch { /* raw payload */ }
    if (type && INVITE_OPS.has(type)) {
      // Only the accept travels in plaintext; any other invite op in plaintext is dropped.
      if (type === OP_ACCEPT && this.claim()) {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(text); } catch { /* malformed: the engine refuses it */ }
        await this.flow.handleControl(type, from, payload);
      }
      return { kind: 'control' };
    }
    if (classifyInviteText(text) === 'valid') return this.inviteLeak(from);
    // Plaintext naming a PINNED sender (spec D6). On the relay path the sender is only the relay's
    // word, so it counts as from that peer only when the envelope is signed by the pinned key.
    // Once a peer has sent us encrypted chat, plaintext claiming to be from it is a downgrade and is
    // refused. Otherwise it is delivered marked as an unverified claim (Instar before step 9 sends
    // ordinary chat in plaintext). It never counts as a credential, and we never reply in plaintext.
    const pin = keys.getProfileByFingerprint(from);
    if (!pin?.peerIdentityPub) {
      // With the pin store set aside, a sender that was paired looks unpaired; never present its plaintext as plainly from it.
      return this.pinStoreBroken()
        ? { kind: 'message', text, type, encrypted: false, credential: false, unverifiedPairedClaim: true }
        : { kind: 'message', text, type, encrypted: false, credential: false };
    }
    if (this.encryptedChatSeen(from)) {
      this.refusedPlaintext.set(from, (this.refusedPlaintext.get(from) ?? 0) + 1);
      return { kind: 'refused', reason: 'plaintext from a paired agent that has sent encrypted messages before (possible downgrade)' };
    }
    const signed = typeof env.signature === 'string'
      && verify(Buffer.from(pin.peerIdentityPub, 'hex'), Buffer.from(canonicalizeEnvelope(env as Record<string, unknown>), 'utf-8'), Buffer.from(env.signature, 'base64'));
    return signed
      ? { kind: 'message', text, type, encrypted: false, credential: false, fromPairedPeer: true }
      : { kind: 'message', text, type, encrypted: false, credential: false, unverifiedPairedClaim: true };
  }

  /** The newest pairing events as plain lines, for the inbox. */
  systemLines(limit = 5): string[] {
    const attention = this.storeProblems.map((p) => `${p.at} Pairing ATTENTION: ${p.message} Pairings recorded in it are not in use until the file is repaired; tell your person.`);
    const alarms = this.alarms.map((a) => `${a.at} Pairing ALARM: ${a.message}`);
    return [...attention, ...alarms, ...this.recent.slice(0, limit).map((r) => `${r.at} ${describePairingEvent(r.event)}`)];
  }

  /** Recent pairing events (accepts waiting, leak alarms, paired), newest first. Never secrets. */
  recentEvents(): StandaloneEvent[] {
    return [...this.recent];
  }

  /** Invites waiting for this person's Finish (used, with an acceptor, undecided, not leaked). */
  waitingToFinish() {
    return this.invites.list().filter((i) => i.state === 'used' && i.acceptor && !i.decision && !i.secondAccept);
  }
}
