/**
 * Public-key directory for Agent-Signature Provenance.
 *
 * Spec anchor: docs/specs/agent-signature-provenance.md
 *
 * Resolves an agent id to the Ed25519 public key we hold for it, so signatures
 * from peers — not just from self — can be verified.
 *
 * ── WHAT A RESOLVED KEY DOES AND DOES NOT PROVE ───────────────────────────
 * This directory answers: "which key do we have on file for the name `codey`?"
 * A successful verification against that key therefore proves the message was
 * signed by *the holder of that key*. It does NOT prove that key belongs to the
 * real Codey — that binding is made by the pairing/SAS layer, where a human
 * compares words out of band.
 *
 * The two are easy to conflate and the conflation is dangerous, so the
 * distinction is carried in the return value: every resolution reports its
 * `trust` source. `discovery` means "a key learned from the local discovery
 * cache" — good enough to distinguish agents from each other and to reject
 * forgeries, NOT good enough to stake a human-consequential decision on.
 *
 * Reminder from the spec's open question: none of this settles AUTHORITY. A
 * mutually-verified agent is still not thereby permitted to decide anything.
 *
 * ── FAIL CLOSED ───────────────────────────────────────────────────────────
 * Unknown id, malformed key, unreadable file -> null. A null resolution makes
 * the verifier answer `unknown-agent`, which is a rejection. Nothing here can
 * turn an unrecognised signer into a trusted one.
 */

import fs from 'fs';
import path from 'path';

export type AspKeyTrust = 'self' | 'mutual-verified' | 'discovery';

export interface AspKeyResolution {
  agentId: string;
  publicKey: Buffer;
  trust: AspKeyTrust;
}

interface KnownAgentsFile {
  agents?: Array<{ name?: unknown; publicKey?: unknown; status?: unknown }>;
}

export interface AspKeyDirectoryOptions {
  /** Agent state dir (the one containing identity.json). */
  stateDir: string;
  /** This agent's own id. */
  selfAgentId: string;
  /** Re-read the peer file at most this often. Default 30s. */
  reloadIntervalMs?: number;
  now?: () => number;
}

/** Ed25519 raw public keys are exactly 32 bytes. */
const KEY_BYTES = 32;

export class AspKeyDirectory {
  private readonly opts: AspKeyDirectoryOptions;
  private readonly now: () => number;
  private cache = new Map<string, AspKeyResolution>();
  private loadedAt = 0;

  constructor(opts: AspKeyDirectoryOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Resolve with trust context. Returns null when we hold no usable key. */
  resolve(agentId: string): AspKeyResolution | null {
    if (typeof agentId !== 'string' || agentId === '') return null;
    this.refreshIfStale();
    return this.cache.get(agentId) ?? null;
  }

  /** Adapter for `verifyMessage`, which wants only the key. */
  resolver(): (agentId: string) => Buffer | null {
    return (agentId: string) => this.resolve(agentId)?.publicKey ?? null;
  }

  /** Everything we currently hold. Diagnostics; never includes private material. */
  list(): Array<{ agentId: string; trust: AspKeyTrust; fingerprint: string }> {
    this.refreshIfStale();
    return [...this.cache.values()].map((r) => ({
      agentId: r.agentId,
      trust: r.trust,
      fingerprint: r.publicKey.toString('hex').slice(0, 16),
    }));
  }

  /** Force a reload on the next resolve. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  private refreshIfStale(): void {
    const interval = this.opts.reloadIntervalMs ?? 30_000;
    if (this.loadedAt !== 0 && this.now() - this.loadedAt < interval) return;
    this.load();
  }

  private load(): void {
    const next = new Map<string, AspKeyResolution>();

    // Self first, and never overwritten by a peer entry below: a discovery file
    // claiming a different key for our own name must not displace our identity.
    const selfKey = this.readSelfKey();
    if (selfKey) {
      next.set(this.opts.selfAgentId, {
        agentId: this.opts.selfAgentId, publicKey: selfKey, trust: 'self',
      });
    }

    for (const peer of this.readPeers()) {
      if (next.has(peer.agentId)) continue; // self wins
      next.set(peer.agentId, peer);
    }

    this.cache = next;
    this.loadedAt = this.now();
  }

  private readSelfKey(): Buffer | null {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(this.opts.stateDir, 'identity.json'), 'utf8')
      ) as { publicKey?: unknown };
      return decodeKey(raw?.publicKey);
    } catch {
      /* @silent-fallback-ok: no identity on disk is a legitimate state (fresh agent), not an
         error. Returning null means self is unresolvable, so every signature classifies
         `unknown-agent` — a REJECTION. This degrades toward refusal, never toward trust. */
      return null;
    }
  }

  private readPeers(): AspKeyResolution[] {
    try {
      const file = JSON.parse(
        fs.readFileSync(path.join(this.opts.stateDir, 'threadline', 'known-agents.json'), 'utf8')
      ) as KnownAgentsFile;
      const out: AspKeyResolution[] = [];
      for (const a of file.agents ?? []) {
        if (typeof a?.name !== 'string' || a.name === '') continue;
        const key = decodeKey(a.publicKey);
        if (!key) continue;
        out.push({ agentId: a.name, publicKey: key, trust: 'discovery' });
      }
      return out;
    } catch {
      /* @silent-fallback-ok: a missing or damaged discovery cache means we simply KNOW FEWER
         AGENTS. Every unknown id resolves null -> `unknown-agent` -> rejection, so the failure
         mode is strictly more refusal, never accidental trust. Tested: 'a missing or corrupt
         peer file degrades to fewer agents, never to trust'. */
      return [];
    }
  }
}

/** Accept 64-char hex (the threadline on-disk form) or 44-char base64. */
function decodeKey(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(value)) {
      const b = Buffer.from(value, 'hex');
      return b.length === KEY_BYTES ? b : null;
    }
    const b = Buffer.from(value, 'base64');
    return b.length === KEY_BYTES ? b : null;
  } catch {
    /* @silent-fallback-ok: a malformed key is DROPPED rather than coerced — an unusable key must
       never become a usable one. The caller sees null and the agent stays unresolvable. */
    return null;
  }
}
