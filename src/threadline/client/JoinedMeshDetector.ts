/**
 * JoinedMeshDetector — is this agent home a machine that JOINED an existing mesh?
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §2, revised by
 * docs/specs/a2a-single-agent-identity.md §1.1.
 * Constitution: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions".
 *
 * WHY THIS EXISTS. `IdentityManager.getOrCreate()` and `createUnifiedTrustSystem` mint a fresh
 * agent keypair when they find none on disk. That is correct for the FIRST machine of a new
 * agent and catastrophic for the second: a machine that joined an existing agent's mesh has an
 * identity — it just was not carried to it — so minting there silently turns one agent into two
 * that share a name (observed live 2026-08-19 and again 2026-08-26/2026-10-08).
 *
 * THE DISCRIMINATOR IS AN ON-DISK FACT, NOT A HEURISTIC. A joined home carries a machine
 * registry naming at least one machine OTHER than itself — written by `joinMesh` /
 * `MachineIdentityManager.registerMachine` during pairing, before the server ever starts. A
 * standalone first machine has no such record.
 *
 * FAILS TOWARD REFUSING, DELIBERATELY (a2a-single-agent-identity §1.1 — the parent's
 * direction is REVERSED). The parent let an unreadable registry fall toward minting so a
 * filesystem fault could not brick a standalone agent. But a registry file's EXISTENCE is
 * itself pairing evidence (a standalone first machine has none), and minting there is exactly
 * how a rebuilt sibling recreated the split. So:
 *   - no registry file           → standalone first machine → mint (as before);
 *   - registry naming any other  → joined → refuse;
 *   - registry with rows but no  → refuse (it used to mint);
 *     own machine id
 *   - registry present but       → `unreadable` → refuse (it used to mint).
 *     unreadable / unparseable
 * ENOENT and EACCES are no longer collapsed: an absent file is `no-registry`; a present file
 * that cannot be read is `unreadable`. The one case this costs — a single-machine agent with no
 * identity AND a corrupt registry — boots loud, and the lever (`instar identity init
 * --standalone`) is named in the refusal.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Why the detector answered as it did — surfaced so a refusal can explain itself. */
export type JoinedMeshVerdict =
  | { joined: true; mintAllowed: false; peerMachineCount: number; source: string }
  | { joined: false; mintAllowed: true; reason: 'no-registry' | 'self-only' }
  | {
      joined: false;
      mintAllowed: false;
      /**
       * `unreadable`: a registry file exists but cannot be read or parsed (the §1.1 third
       * verdict). `no-machine-id`: the registry has rows but this machine's own id cannot be
       * read, so "lists only me" cannot be told from "lists a peer" — refused, never guessed.
       */
      reason: 'unreadable' | 'no-machine-id';
      detail: string;
      source: string;
    };

/**
 * Decide whether this home joined an existing mesh — and, separately, whether minting an
 * agent identity here is allowed (`mintAllowed`). Both mint sites consult `mintAllowed`.
 *
 * Pure over the injected readers so the decision is testable without a real mesh on disk.
 */
export function detectJoinedMesh(
  stateDir: string,
  deps: {
    readFile?: (p: string) => string;
    /** This machine's own id, so "the registry lists only me" is not read as "I joined". */
    selfMachineId?: () => string | null;
  } = {},
): JoinedMeshVerdict {
  const readFile = deps.readFile ?? ((f: string) => fs.readFileSync(f, 'utf-8'));
  const registryPath = path.join(stateDir, 'machines', 'registry.json');

  let raw: string;
  try {
    raw = readFile(registryPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT is the ordinary standalone case: no pairing has ever written a registry here.
    if (code === 'ENOENT') return { joined: false, mintAllowed: true, reason: 'no-registry' };
    // Anything else (EACCES, EIO, …) means a registry EXISTS and this process cannot read it.
    // That file is pairing evidence; minting over it is how a split is recreated. Refuse.
    return {
      joined: false,
      mintAllowed: false,
      reason: 'unreadable',
      detail: `registry could not be read (${code ?? 'error'})`,
      source: registryPath,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      joined: false,
      mintAllowed: false,
      reason: 'unreadable',
      detail: 'registry is not valid JSON',
      source: registryPath,
    };
  }

  const machines = (parsed as { machines?: Record<string, unknown> } | null)?.machines;
  if (!machines || typeof machines !== 'object') {
    return {
      joined: false,
      mintAllowed: false,
      reason: 'unreadable',
      detail: 'registry has no machines object',
      source: registryPath,
    };
  }

  const selfId = deps.selfMachineId ? deps.selfMachineId() : readSelfMachineId(stateDir, readFile);
  const ids = Object.keys(machines);
  const peers = selfId ? ids.filter((id) => id !== selfId) : ids;

  // Without a self id we cannot tell "the registry lists only me" from "it lists a peer". The
  // parent resolved this toward minting; §1.1 reverses it: rows are present, so this home has
  // been through pairing, and a guess here is exactly the split.
  if (!selfId && ids.length > 0) {
    return {
      joined: false,
      mintAllowed: false,
      reason: 'no-machine-id',
      detail: `registry lists ${ids.length} machine(s) but this machine's own id could not be read`,
      source: registryPath,
    };
  }
  if (peers.length === 0) return { joined: false, mintAllowed: true, reason: 'self-only' };

  return { joined: true, mintAllowed: false, peerMachineCount: peers.length, source: registryPath };
}

/** One-line operator-facing explanation of a refusing verdict (names the lever). */
export function describeMintRefusal(verdict: JoinedMeshVerdict): string {
  if (verdict.joined) {
    return `this machine joined an agent mesh with ${verdict.peerMachineCount} other machine(s); the identity is adopted from a sibling, never minted here`;
  }
  if (verdict.mintAllowed) return 'minting is allowed';
  const lever = 'if this is genuinely a single-machine agent, run `instar identity init --standalone --i-understand-peers-must-repin` on it';
  return `${verdict.reason}: ${verdict.detail} (${verdict.source}); ${lever}`;
}

/** This machine's own id, or null when it cannot be read. */
function readSelfMachineId(stateDir: string, readFile: (p: string) => string): string | null {
  try {
    // NOTE the singular `machine/` — this machine's OWN identity lives there, while
    // `machines/` holds the registry plus a directory per REMOTE machine. Reading the wrong
    // one yields no self id, which (since §1.1) routes to the REFUSING `no-machine-id` branch
    // rather than a silent mint. Verified against a real joined home, 2026-08-19.
    const d = JSON.parse(readFile(path.join(stateDir, 'machine', 'identity.json'))) as {
      machineId?: unknown;
    };
    return typeof d.machineId === 'string' && d.machineId.length > 0 ? d.machineId : null;
  } catch {
    // @silent-fallback-ok: handled by the `no-machine-id` branch above, which now refuses
    // (fail-closed) rather than minting.
    return null;
  }
}
