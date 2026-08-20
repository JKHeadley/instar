/**
 * JoinedMeshDetector — is this agent home a machine that JOINED an existing mesh?
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §2.
 * Constitution: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions".
 *
 * WHY THIS EXISTS. `IdentityManager.getOrCreate()` mints a fresh agent keypair when it finds
 * none on disk. That is correct for the FIRST machine of a new agent and catastrophic for the
 * second: a machine that joined an existing agent's mesh has an identity — it just was not
 * carried to it — so minting there silently turns one agent into two that share a name.
 *
 * Observed live (2026-08-19): the operator authorised a Mac Mini to extend echo onto a Mac
 * Studio. The Studio joined the mesh correctly in every visible respect, then minted
 * `ae6feac6…` while the Mini and Laptop both publish `63b1dbb2…`. A plain-text message signed
 * on the Studio verifies there and is rejected as `bad-signature` on BOTH peers, so the
 * agent-signature feature is inoperative from that machine.
 *
 * THE DISCRIMINATOR IS AN ON-DISK FACT, NOT A HEURISTIC. A joined home carries a machine
 * registry naming at least one machine OTHER than itself — written by `joinMesh` /
 * `MachineIdentityManager.registerMachine` during pairing, before the server ever starts. A
 * standalone first machine has no such record. That is what makes this guard safe to enforce
 * immediately rather than ship dark: the two cases are distinguished by evidence, and the
 * uncertain case is resolved toward the pre-existing behaviour.
 *
 * FAILS TOWARD MINTING, DELIBERATELY. An unreadable or absent registry answers `false` (not
 * joined), so an unrelated filesystem problem cannot brick a legitimate standalone agent by
 * refusing it an identity. The cost of that choice is that a joined machine with a corrupt
 * registry could still mint — which the divergence detector (§4) is there to catch.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Why the detector answered as it did — surfaced so a refusal can explain itself. */
export type JoinedMeshVerdict =
  | { joined: true; peerMachineCount: number; source: string }
  | { joined: false; reason: 'no-registry' | 'registry-unreadable' | 'self-only' | 'no-machine-id' };

/**
 * Decide whether this home joined an existing mesh.
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
  } catch {
    // @silent-fallback-ok: no registry is the ordinary standalone case, and an unreadable one
    // must not brick a legitimate agent. Both answer "not joined" — the direction that
    // preserves today's behaviour. §4's divergence detector covers the residual risk.
    return { joined: false, reason: 'no-registry' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { joined: false, reason: 'registry-unreadable' };
  }

  const machines = (parsed as { machines?: Record<string, unknown> } | null)?.machines;
  if (!machines || typeof machines !== 'object') return { joined: false, reason: 'registry-unreadable' };

  const selfId = deps.selfMachineId ? deps.selfMachineId() : readSelfMachineId(stateDir, readFile);
  const ids = Object.keys(machines);
  const peers = selfId ? ids.filter((id) => id !== selfId) : ids;

  // Without a self id we cannot tell "the registry lists only me" from "it lists a peer", so
  // any entry at all would read as joined. Refuse to conclude rather than guess: this branch
  // resolves to NOT joined, preserving the mint.
  if (!selfId && ids.length > 0) return { joined: false, reason: 'no-machine-id' };
  if (peers.length === 0) return { joined: false, reason: 'self-only' };

  return { joined: true, peerMachineCount: peers.length, source: registryPath };
}

/** This machine's own id, or null when it cannot be read. */
function readSelfMachineId(stateDir: string, readFile: (p: string) => string): string | null {
  try {
    // NOTE the singular `machine/` — this machine's OWN identity lives there, while
    // `machines/` holds the registry plus a directory per REMOTE machine. Reading the wrong
    // one yields no self id, which routes to the mint-preserving branch and would have made
    // this guard silently inert. Verified against a real joined home, 2026-08-19.
    const d = JSON.parse(readFile(path.join(stateDir, 'machine', 'identity.json'))) as {
      machineId?: unknown;
    };
    return typeof d.machineId === 'string' && d.machineId.length > 0 ? d.machineId : null;
  } catch {
    // @silent-fallback-ok: handled by the `no-machine-id` branch above, which fails toward
    // minting rather than toward refusing a legitimate standalone agent.
    return null;
  }
}
