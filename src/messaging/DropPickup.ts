/**
 * DropPickup — ingest messages from the drop directory on server startup.
 *
 * When an agent is offline, other agents on the same machine write messages
 * to ~/.instar/messages/drop/{agentName}/. On startup, this module scans
 * the drop directory, verifies each envelope's HMAC, ingests valid messages,
 * and cleans up processed files.
 *
 * Security: Each dropped envelope carries an HMAC-SHA256 computed with the
 * sending agent's token. This prevents local processes from forging messages
 * or tampering with routing metadata via the drop directory.
 *
 * Derived from: docs/specs/INTER-AGENT-MESSAGING-SPEC.md v3.1 §Cross-Agent Resolution
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MessageEnvelope } from './types.js';
import type { MessageStore } from './MessageStore.js';
import { verifyDropHmac } from './AgentTokenManager.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import {
  appendLocalRouteSignatureAudit,
  countLocalEnvelopeVerdict,
  localRouteSignatureCounters,
  readRegistrySnapshot,
  verifyLocalRouteEnvelope,
  type LocalEnvelopeVerifier,
  type LocalRouteSignatureMode,
} from '../threadline/localEnvelopeSignature.js';

/** A held drop older than this (file modification time) is deleted by the second pass. */
export const HELD_DROP_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * A2A local-route signed envelope (docs/specs/a2a-local-route-signed-envelope.md §7):
 * the signature check drop pickup applies AFTER its own checks.
 */
export interface DropSignatureCheck {
  mode: LocalRouteSignatureMode;
  /** The receiver's state directory (its registry lives under it). */
  stateDir: string;
  /**
   * 'boot': peers are not listening yet — verify against the registry only,
   * never probe, never expire. 'second': the first-contact probe is allowed,
   * and an unproven drop older than 7 days is deleted.
   */
  pass: 'boot' | 'second';
  now?: number;
  verifier?: LocalEnvelopeVerifier;
}

export interface DropPickupResult {
  /** Number of messages successfully ingested */
  ingested: number;
  /** Number of messages rejected (invalid HMAC, bad format, etc.) */
  rejected: number;
  /** Number of messages skipped (already in store — dedup) */
  duplicates: number;
  /** Details of rejected messages for logging */
  rejections: Array<{ file: string; reason: string }>;
  /** Enforcing: unproven drops left in place this pass. */
  held: number;
  /** Enforcing, second pass: unproven drops older than 7 days, deleted. */
  expired: number;
  /** Sender names behind held/expired drops (bounded, log-safe). */
  heldSenders: string[];
}

/**
 * Scan the drop directory for this agent and ingest valid messages.
 *
 * @param agentName - This agent's name (used to locate drop dir and verify auth)
 * @param store - The message store to ingest into
 * @returns Summary of what was processed
 */
export async function pickupDroppedMessages(
  agentName: string,
  store: MessageStore,
  signature?: DropSignatureCheck,
): Promise<DropPickupResult> {
  const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', agentName);

  const result: DropPickupResult = {
    ingested: 0,
    rejected: 0,
    duplicates: 0,
    rejections: [],
    held: 0,
    expired: 0,
    heldSenders: [],
  };
  const sigMode: LocalRouteSignatureMode = signature?.mode ?? 'off';
  const now = signature?.now ?? Date.now();
  // One registry read for the whole pass.
  const registry = sigMode !== 'off' && signature ? readRegistrySnapshot(signature.stateDir) : undefined;
  const noteSender = (name: string | null) => {
    const safe = (name ?? 'unknown').replace(/[^\x21-\x7e]/g, '?').slice(0, 48) || 'unknown';
    if (!result.heldSenders.includes(safe) && result.heldSenders.length < 16) result.heldSenders.push(safe);
  };

  // No drop directory = nothing to pick up
  if (!fs.existsSync(dropDir)) {
    return result;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dropDir).filter(f => f.endsWith('.json'));
  } catch {
    // @silent-fallback-ok — directory not readable, nothing to process
    return result;
  }

  for (const file of files) {
    const filePath = path.join(dropDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const envelope: MessageEnvelope = JSON.parse(raw);

      // Validate envelope structure
      if (!envelope?.message?.id || !envelope?.transport || !envelope?.delivery) {
        result.rejected++;
        result.rejections.push({ file, reason: 'invalid envelope structure' });
        unlinkSafe(filePath);
        continue;
      }

      // Deduplication: skip if already in store
      if (await store.exists(envelope.message.id)) {
        result.duplicates++;
        unlinkSafe(filePath);
        continue;
      }

      // Verify HMAC if present
      if (envelope.transport.hmac && envelope.transport.hmacBy) {
        const valid = verifyDropHmac(
          envelope.transport.hmacBy,
          envelope.transport.hmac,
          {
            message: envelope.message,
            originServer: envelope.transport.originServer,
            nonce: envelope.transport.nonce,
            timestamp: envelope.transport.timestamp,
          },
        );

        if (!valid) {
          result.rejected++;
          result.rejections.push({ file, reason: `invalid HMAC from ${envelope.transport.hmacBy}` });
          unlinkSafe(filePath);
          continue;
        }
      } else {
        // No HMAC — reject (spec requires HMAC on all drops)
        result.rejected++;
        result.rejections.push({ file, reason: 'missing HMAC' });
        unlinkSafe(filePath);
        continue;
      }

      // Signature check (after the existing checks, which delete as before).
      // dry-run: verify + count, ingest as today. enforcing: an unproven drop
      // is HELD in place — never deleted on its first look, because the cause
      // may be the receiver's (a key it has not fetched yet) or an older sender.
      if (sigMode !== 'off' && signature) {
        let proven = false;
        let senderName: string | null = typeof envelope.message?.from?.agent === 'string' ? envelope.message.from.agent : null;
        let reason: Parameters<typeof appendLocalRouteSignatureAudit>[1]['reason'] = 'error';
        try {
          const verdict = await verifyLocalRouteEnvelope(envelope, {
            stateDir: signature.stateDir,
            selfName: agentName,
            now,
            offline: true,
            registry,
            allowProbe: signature.pass === 'second',
            verifier: signature.verifier,
          });
          proven = verdict.ok;
          senderName = verdict.senderName ?? senderName;
          if (!verdict.ok) reason = verdict.reason;
          // dry-run counts like the route (verified / wouldRefuse + byReason);
          // enforcing drops have their own outcomes, counted below.
          if (sigMode === 'dry-run') countLocalEnvelopeVerdict(sigMode, verdict);
        } catch {
          // A verifier error never reaches the deleting catch below: it holds
          // (enforcing) or ingests (dry-run).
          localRouteSignatureCounters.errors++;
        }
        const audit = (outcome: 'verified' | 'would-refuse' | 'held' | 'expired') => appendLocalRouteSignatureAudit(
          signature.stateDir,
          { source: 'drop', mode: sigMode, outcome, from: senderName, ...(outcome === 'verified' ? {} : { reason }) },
          now,
        );
        if (proven) {
          localRouteSignatureCounters.dropsVerified++;
          audit('verified');
        } else if (sigMode === 'enforcing') {
          let ageMs = 0;
          try { ageMs = now - fs.statSync(filePath).mtimeMs; } catch { /* @silent-fallback-ok — age unknown: treat as new, hold */ }
          noteSender(senderName);
          if (signature.pass === 'second' && ageMs > HELD_DROP_MAX_AGE_MS) {
            result.expired++;
            localRouteSignatureCounters.dropsExpired++;
            audit('expired');
            unlinkSafe(filePath);
          } else {
            result.held++;
            localRouteSignatureCounters.dropsHeld++;
            audit('held');
          }
          continue;
        } else {
          audit('would-refuse');
        }
      }

      // Update delivery phase to 'received'
      const nowIso = new Date(now).toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'received',
        transitions: [
          ...envelope.delivery.transitions,
          { from: envelope.delivery.phase, to: 'received', at: nowIso, reason: 'picked up from drop directory' },
        ],
      };

      // Ingest into store
      await store.save(envelope);
      result.ingested++;

      // Clean up processed file
      unlinkSafe(filePath);
    } catch {
      // @silent-fallback-ok — malformed file, skip it
      result.rejected++;
      result.rejections.push({ file, reason: 'parse error or I/O failure' });
      unlinkSafe(filePath);
    }
  }

  return result;
}

/** Safely delete a file, ignoring errors */
function unlinkSafe(filePath: string): void {
  try {
    SafeFsExecutor.safeUnlinkSync(filePath, { operation: 'src/messaging/DropPickup.ts:147' });
  } catch {
    // @silent-fallback-ok — file may already be deleted
  }
}
