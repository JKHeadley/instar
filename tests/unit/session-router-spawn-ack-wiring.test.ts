/**
 * Wiring integrity — the SessionRouter placement hop in the server.ts
 * composition root. 2026-11-01 (Echo Bugs topic 10000001183): spawnOnMachine
 * sent epoch 0 and discarded the reply, so a receiver that NACKed it stale was
 * logged `spawned` and the message was lost. Source-parse is the established
 * convention for composition-root wiring.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('SessionRouter spawn hop — server.ts wiring', () => {
  const at = src.indexOf('spawnOnMachine: async (machineId, msg, ownershipEpoch) => {');

  it('sends the CAS-landed epoch and the sender frame, and returns the receiver ACK', () => {
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 1200);
    expect(block).toContain("type: 'deliverMessage'");
    expect(block).toContain('ownershipEpoch, ...(msg.senderEnvelope');
    expect(block).not.toContain('ownershipEpoch: 0');
    expect(block).toContain("'accepted' in (res.result as object)");
    expect(block).toContain('return res.result as');
    expect(block).toContain('throw new Error(`spawn deliverMessage rejected');
  });

  it('reclaimPlacement is wired over the authoritative registry, only for the still-placing record', () => {
    const rc = src.indexOf('reclaimPlacement: (sk, placedOn) => {');
    expect(rc).toBeGreaterThan(at);
    const block = src.slice(rc, rc + 700);
    expect(block).toContain("cur.status !== 'placing' || cur.ownerMachineId !== placedOn");
    expect(block).toContain("ownReg.cas({ type: 'force-claim', machineId: meshSelfId }");
    expect(block).toContain('++routerNonce');
    expect(block).toContain("emitPlacement(sk, r, 'failover', placedOn)");
    expect(block).toContain('return r.ok;');
  });
});
