import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { FACE_ID_CURRENT_SET_ASSURANCE, verifyDedicatedSignature } from '../core/trustJourney/biometricCurrentSetProof.js';

type Caller = Readonly<{
  origin: string; authorityId: string; ownerRevision: string; deviceId: string; deviceKeyHash: string;
  holderEpoch: string; holderIncarnation: string; biometricKeyHash: string; biometricKeyGeneration: string;
}>;
type Challenge = readonly [
  domain: 'instar.owner-approval.confirm.biometric.v1', origin: string, authorityId: string, holderEpoch: string,
  holderIncarnation: string, ownerRevision: string, deviceId: string, deviceKeyHash: string, biometricKeyHash: string,
  biometricKeyGeneration: string, requestId: string, actionId: 'subscription-relogin.configure.v1', proposalHash: string,
  challengeId: string, nonce: string, expiresAtMs: string, localAssurance: typeof FACE_ID_CURRENT_SET_ASSURANCE,
];
type Submit = Readonly<{ proposalHash: string; challengeId: string; localAssurance: string; signature: string }>;
type Receipt = Readonly<{
  status: 'accepted' | 'pending'; requestId: string; proposalHash: string; challengeId: string;
  receiptId: string | null; results: readonly unknown[];
}>;
interface ProofAtCommit {
  challenge: Challenge;
  proposalExpiresAtMs: string;
  keySpkiBase64: string;
  eligible: boolean;
  historical: boolean;
  targetMachineIds: readonly string[];
}

const root = '/mobile/owner-approvals';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const decimal = /^[1-9][0-9]{0,15}$/;
const resultErrors = new Set([
  'target-unreachable', 'delivery-failed', 'delivery-refused', 'route-missing', 'invalid-config',
  'outcome-unknown', 'apply-failed', 'revision-mismatch', 'stale-revision', 'config-mismatch',
]);
const bytes = (fields: readonly unknown[]) => Buffer.from(JSON.stringify(fields), 'utf8');
const digest = (fields: readonly unknown[]) => createHash('sha256').update(bytes(fields)).digest('hex');

function live(expiry: string, now: number): boolean {
  return typeof expiry === 'string' && decimal.test(expiry) && Number.isSafeInteger(Number(expiry))
    && Number.isSafeInteger(now) && now >= 0 && now < Number(expiry);
}

function exactChallenge(challenge: Challenge, caller: Caller, id: string, proposalHash: string): boolean {
  return challenge.length === 17 && challenge[0] === 'instar.owner-approval.confirm.biometric.v1'
    && challenge[1] === caller.origin && challenge[2] === caller.authorityId && challenge[3] === caller.holderEpoch
    && challenge[4] === caller.holderIncarnation && challenge[5] === caller.ownerRevision && challenge[6] === caller.deviceId
    && challenge[7] === caller.deviceKeyHash && challenge[8] === caller.biometricKeyHash
    && challenge[9] === caller.biometricKeyGeneration && challenge[10] === id
    && challenge[11] === 'subscription-relogin.configure.v1' && challenge[12] === proposalHash
    && uuid.test(challenge[13]) && /^[A-Za-z0-9_-]{43}$/.test(challenge[14])
    && Buffer.from(challenge[14], 'base64url').toString('base64url') === challenge[14]
    && challenge[16] === FACE_ID_CURRENT_SET_ASSURANCE;
}

function currentDisclosure(fields: readonly unknown[] | null, caller: Caller, id: string, now: number):
    fields is readonly unknown[] & { 8: string } {
  return !!fields && fields.length === 10 && fields[0] === 'instar.owner-approval.disclosure.v1'
    && fields[1] === caller.origin && fields[2] === caller.authorityId && fields[3] === caller.ownerRevision
    && fields[4] === caller.deviceId && fields[5] === id && fields[6] === 'subscription-relogin.configure.v1'
    && typeof fields[8] === 'string' && live(fields[8], now);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function projectResults(results: readonly unknown[], targets: ReadonlySet<string>, complete: boolean) {
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const value of results) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.machineId !== 'string' || !targets.has(row.machineId)
      || seen.has(row.machineId) || typeof row.ok !== 'boolean') return null;
    seen.add(row.machineId);
    rows.push({
      machineId: row.machineId, ok: row.ok,
      ...(row.mode === 'approval' || row.mode === 'unattended' || row.mode === 'off' || row.mode === 'observe' ? { mode: row.mode } : {}),
      ...(typeof row.changed === 'boolean' ? { changed: row.changed } : {}),
      ...(typeof row.restartRequested === 'boolean' ? { restartRequested: row.restartRequested } : {}),
      ...(typeof row.revision === 'string' && /^sha256:[a-f0-9]{64}$/.test(row.revision) ? { revision: row.revision } : {}),
      ...(row.ok === false && typeof row.error === 'string'
        ? { error: resultErrors.has(row.error) ? row.error : 'apply-failed' } : {}),
    });
  }
  return complete && seen.size !== targets.size ? null : rows;
}

/** Disposable HTTP adapter. The normal server does not mount it. */
// E2E-PAIRING: EXEMPT — explicit return type for declaration emit; no runtime change.
export function createNativeOwnerApprovalRoutes(deps: {
  enabled?: boolean;
  /** From the normal signed owner request and current verified dedicated binding. */
  authenticate(req: Request): Caller | null;
  now(): number;
  sign(fields: Buffer): { signerKeyId: string; signature: string } | null;
  inventory(caller: Caller): { expiresAtMs: string; entries: readonly (readonly [string, string])[] } | null;
  disclosure(caller: Caller, requestId: string): readonly unknown[] | null;
  open(caller: Caller, requestId: string, proposalHash: string): Challenge | null;
  /** Resolve current authority again, evaluate the predicate, then consume and record atomically.
   * A historical state is supplied only for an exact authenticated retry of a recorded receipt. */
  consume(caller: Caller, requestId: string, proof: Submit, validate: (current: ProofAtCommit) => boolean):
    Promise<Receipt | null>;
}): Router {
  const router = Router();
  if (deps.enabled !== true) return router;

  const admit = (req: Request, res: Response, path: string): Caller | null => {
    res.set('Cache-Control', 'no-store');
    if (req.originalUrl !== path) { res.sendStatus(404); return null; }
    const caller = deps.authenticate(req);
    if (!caller) res.sendStatus(403);
    return caller && Object.freeze({ ...caller });
  };
  const signed = (res: Response, field: string, fields: readonly unknown[]) => {
    const proof = deps.sign(bytes(fields));
    if (!proof) { res.sendStatus(503); return; }
    res.json({ [field]: fields, signerKeyId: proof.signerKeyId, signature: proof.signature });
  };

  router.get(root, (req, res) => {
    const caller = admit(req, res, root);
    if (!caller) return;
    const inventory = deps.inventory(caller);
    if (!inventory || !live(inventory.expiresAtMs, deps.now())) { res.sendStatus(503); return; }
    const entries = inventory.entries.map(([id, proposalHash]) => [id, proposalHash]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.some(([id, proposalHash], i) => !uuid.test(id) || !hash.test(proposalHash) || id === entries[i - 1]?.[0])) {
      res.sendStatus(503); return;
    }
    signed(res, 'inventory', ['instar.owner-approval.inventory.v1', caller.origin, caller.authorityId,
      caller.ownerRevision, caller.deviceId, inventory.expiresAtMs, entries]);
  });

  router.get(`${root}/:requestId`, (req, res) => {
    const id = String(req.params.requestId);
    if (!uuid.test(id)) { res.sendStatus(404); return; }
    const caller = admit(req, res, `${root}/${id}`);
    if (!caller) return;
    const disclosure = deps.disclosure(caller, id);
    if (!currentDisclosure(disclosure, caller, id, deps.now())) { res.sendStatus(404); return; }
    signed(res, 'disclosure', disclosure);
  });

  router.post(`${root}/:requestId/challenge`, (req, res) => {
    const id = String(req.params.requestId);
    if (!uuid.test(id)) { res.sendStatus(404); return; }
    const caller = admit(req, res, `${root}/${id}/challenge`);
    if (!caller) return;
    if (!exactKeys(req.body, ['proposalHash']) || typeof req.body.proposalHash !== 'string' || !hash.test(req.body.proposalHash)) {
      res.sendStatus(400); return;
    }
    const disclosure = deps.disclosure(caller, id);
    if (!currentDisclosure(disclosure, caller, id, deps.now()) || digest(disclosure) !== req.body.proposalHash) {
      res.sendStatus(409); return;
    }
    const challenge = deps.open(caller, id, req.body.proposalHash);
    if (!challenge || !exactChallenge(challenge, caller, id, req.body.proposalHash)
      || !live(challenge[15], deps.now()) || Number(challenge[15]) > Number(disclosure[8])) { res.sendStatus(409); return; }
    signed(res, 'challenge', challenge);
  });

  router.post(`${root}/:requestId/approve`, async (req, res, next) => {
    try {
      const id = String(req.params.requestId);
      if (!uuid.test(id)) { res.sendStatus(404); return; }
      const caller = admit(req, res, `${root}/${id}/approve`);
      if (!caller) return;
      const body = req.body;
      if (!exactKeys(body, ['proposalHash', 'challengeId', 'localAssurance', 'signature'])
        || typeof body.proposalHash !== 'string' || !hash.test(body.proposalHash)
        || typeof body.challengeId !== 'string' || !uuid.test(body.challengeId)
        || body.localAssurance !== FACE_ID_CURRENT_SET_ASSURANCE
        || typeof body.signature !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.signature)) {
        res.sendStatus(400); return;
      }
      const proof = Object.freeze({ proposalHash: body.proposalHash, challengeId: body.challengeId,
        localAssurance: body.localAssurance, signature: body.signature });
      let validated = false;
      const targets = new Set<string>();
      const receipt = await deps.consume(caller, id, proof, current => {
        targets.clear();
        const challenge = current.challenge;
        const now = deps.now();
        validated = exactChallenge(challenge, caller, id, proof.proposalHash) && challenge[13] === proof.challengeId
          && (current.historical === true || (current.eligible === true && live(challenge[15], now)
            && live(current.proposalExpiresAtMs, now) && Number(challenge[15]) <= Number(current.proposalExpiresAtMs)))
          && current.targetMachineIds.length > 0
          && new Set(current.targetMachineIds).size === current.targetMachineIds.length
          && verifyDedicatedSignature(bytes(challenge), caller.biometricKeyHash, current.keySpkiBase64, proof.signature);
        if (validated) for (const machineId of current.targetMachineIds) targets.add(machineId);
        return validated;
      });
      if (!receipt) { res.sendStatus(409); return; }
      if (!validated || (receipt.status !== 'accepted' && receipt.status !== 'pending') || !Array.isArray(receipt.results)
        || (receipt.receiptId === null ? receipt.status !== 'pending' || receipt.results.length !== 0 :
          typeof receipt.receiptId !== 'string' || receipt.receiptId.length === 0)
        || receipt.requestId !== id || receipt.proposalHash !== proof.proposalHash
        || receipt.challengeId !== proof.challengeId) { res.sendStatus(503); return; }
      const results = projectResults(receipt.results, targets, receipt.status === 'accepted');
      if (!results) { res.sendStatus(503); return; }
      res.status(receipt.status === 'pending' ? 202 : 200).json({
        status: receipt.status, requestId: id, proposalHash: proof.proposalHash, challengeId: proof.challengeId,
        receiptId: receipt.receiptId, results,
      });
    } catch (err) { next(err); }
  });
  return router;
}
