/** Single-writer durable registry for reviewed fixed-result shapes. All writes
 * advance one epoch in a SQLite transaction. Readers receive a fresh signed
 * snapshot; replicas cannot issue or revoke certificates. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import type { MachineSigner } from '../core/AppRecordSignatures.js';
import { fixedCertificateIssuanceValid, fixedContractKey, type FixedResultCertificate } from './JobFixedResultCertificate.js';
import type { FixedRevocationProof } from './JobFixedRegistryRevocation.js';
import { signFixedRegistrySnapshot, type FixedCertificateRegistrySnapshot } from './JobFixedCertificateRegistry.js';

interface RegistryRow { epoch: number; certificates_json: string; active_json: string; revoked_json: string }

export class JobFixedRegistryAuthorityStore {
  private readonly db: SqliteDatabase;
  private unregister?: () => void;

  constructor(stateDir: string, private readonly signer: MachineSigner,
    private readonly authorityMachineId: string,
    private readonly ownerPublicKeys: Readonly<Record<string, string>>,
    private readonly reviewerPublicKeys: Readonly<Record<string, string>>) {
    if (signer.machineId() !== authorityMachineId) throw new Error('fixed registry writer is not pinned authority');
    const principals = JSON.stringify({ authorityMachineId,
      owners: Object.entries(ownerPublicKeys).sort(([a], [b]) => a.localeCompare(b)),
      reviewers: Object.entries(reviewerPublicKeys).sort(([a], [b]) => a.localeCompare(b)) });
    if (Buffer.byteLength(principals) > 64 * 1024) throw new Error('fixed registry principal keyset over cap');
    const principalDigest = crypto.createHash('sha256').update(principals).digest('hex');
    const dir = path.join(stateDir, 'ledger');
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, 'job-fixed-registry-authority.db'));
    this.unregister = registerSqliteHandle(() => { try { this.db.close(); } catch { /* already closed */ } });
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(`CREATE TABLE IF NOT EXISTS registry_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL,
        certificates_json TEXT NOT NULL, active_json TEXT NOT NULL, revoked_json TEXT NOT NULL,
        principal_digest TEXT NOT NULL
      )`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS registry_renewals (
        prior_id TEXT PRIMARY KEY, next_id TEXT NOT NULL UNIQUE
      )`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS registry_accepted_misses (
        source_machine_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        certificate_id TEXT NOT NULL, accepted_epoch INTEGER NOT NULL,
        PRIMARY KEY(source_machine_id,attempt_id,certificate_id)
      )`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS registry_contract_misses (
        contract_key TEXT PRIMARY KEY, latest_epoch INTEGER NOT NULL
      )`);
      this.db.prepare(`INSERT OR IGNORE INTO registry_state
        (singleton,epoch,certificates_json,active_json,revoked_json,principal_digest)
        VALUES(1,0,'[]','[]','[]',?)`).run(principalDigest);
      const existing = this.db.prepare('SELECT principal_digest FROM registry_state WHERE singleton=1')
        .get() as { principal_digest: string };
      if (existing.principal_digest !== principalDigest) throw new Error('fixed registry principals changed without versioned migration');
    } catch (error) { this.close(); throw error; }
  }

  close(): void {
    this.unregister?.();
    this.unregister = undefined;
    if (this.db.open) this.db.close();
  }

  private row(): RegistryRow {
    const row = this.db.prepare('SELECT epoch,certificates_json,active_json,revoked_json FROM registry_state WHERE singleton=1')
      .get() as RegistryRow | undefined;
    if (!row) throw new Error('fixed registry state missing');
    return row;
  }

  private latestMissEpoch(cert: FixedResultCertificate): number {
    const row = this.db.prepare('SELECT latest_epoch FROM registry_contract_misses WHERE contract_key=?')
      .get(fixedContractKey(cert)) as { latest_epoch: number } | undefined;
    return row?.latest_epoch ?? 0;
  }

  private missEpochs(): Record<string, number> {
    const rows = this.db.prepare('SELECT contract_key,latest_epoch FROM registry_contract_misses')
      .all() as Array<{ contract_key: string; latest_epoch: number }>;
    return Object.fromEntries(rows.map(row => [row.contract_key, row.latest_epoch]));
  }

  /** The certificate signs its proposed next epoch; this writer verifies both principals. */
  issue(cert: FixedResultCertificate, now = Date.now()): number {
    return this.db.transaction(() => {
      const row = this.row();
      const certificates = JSON.parse(row.certificates_json) as FixedResultCertificate[];
      const active = JSON.parse(row.active_json) as string[];
      const revoked = JSON.parse(row.revoked_json) as string[];
      if (certificates.some(existing => existing.id === cert.id) || revoked.includes(cert.id)) {
        throw new Error('fixed certificate id already used');
      }
      if (certificates.some(existing => active.includes(existing.id) && existing.slug === cert.slug
        && existing.templateDigest === cert.templateDigest && existing.featureStateHash === cert.featureStateHash
        && existing.result === cert.result && existing.summary === cert.summary
        && existing.reasonCode === cert.reasonCode
        && JSON.stringify(Object.entries(existing.fields).sort(([a], [b]) => a.localeCompare(b)))
          === JSON.stringify(Object.entries(cert.fields).sort(([a], [b]) => a.localeCompare(b))))) {
        throw new Error('fixed result shape already active');
      }
      if (cert.reviewedMissEpoch !== this.latestMissEpoch(cert)) {
        throw new Error('fixed certificate has not reviewed latest miss');
      }
      try {
        if (!fixedCertificateIssuanceValid(cert, { epoch: row.epoch + 1,
          ownerPublicKeys: this.ownerPublicKeys, reviewerPublicKeys: this.reviewerPublicKeys, now })) {
          throw new Error('fixed certificate did not pass issuance review');
        }
      } catch { throw new Error('fixed certificate did not pass issuance review'); }
      certificates.push(cert);
      active.push(cert.id);
      if (certificates.length > 1000 || Buffer.byteLength(JSON.stringify({ certificates,
        activeIds: active, revokedIds: revoked, ownerPublicKeys: this.ownerPublicKeys,
        reviewerPublicKeys: this.reviewerPublicKeys, missEpochs: this.missEpochs() })) > 400 * 1024) {
        throw new Error('fixed registry snapshot over cap');
      }
      this.db.prepare(`UPDATE registry_state SET epoch=?,certificates_json=?,active_json=? WHERE singleton=1`)
        .run(row.epoch + 1, JSON.stringify(certificates), JSON.stringify(active));
      return row.epoch + 1;
    })();
  }

  /** Atomically retire a certificate and install a freshly reviewed canary
   * assertion for the same exact shape. A failed validation changes nothing. */
  renew(priorId: string, cert: FixedResultCertificate, now = Date.now()): number {
    return this.db.transaction(() => {
      const row = this.row();
      const certificates = JSON.parse(row.certificates_json) as FixedResultCertificate[];
      const active = JSON.parse(row.active_json) as string[];
      const revoked = JSON.parse(row.revoked_json) as string[];
      const prior = certificates.find(existing => existing.id === priorId);
      if (!prior || !active.includes(priorId) || certificates.some(existing => existing.id === cert?.id)
        || !cert || cert.slug !== prior.slug || cert.templateDigest !== prior.templateDigest
        || cert.featureStateHash !== prior.featureStateHash || cert.result !== prior.result
        || cert.summary !== prior.summary || cert.reasonCode !== prior.reasonCode
        || JSON.stringify(Object.entries(cert.fields ?? {}).sort(([a], [b]) => a.localeCompare(b)))
          !== JSON.stringify(Object.entries(prior.fields).sort(([a], [b]) => a.localeCompare(b)))
        || Date.parse(cert.canaryPassedAt) <= Date.parse(prior.canaryPassedAt)
        || cert.reviewedMissEpoch !== this.latestMissEpoch(cert)
        || !fixedCertificateIssuanceValid(cert, { epoch: row.epoch + 1,
          ownerPublicKeys: this.ownerPublicKeys, reviewerPublicKeys: this.reviewerPublicKeys, now })) {
        throw new Error('fixed certificate renewal review failed');
      }
      certificates.push(cert);
      const nextActive = active.filter(id => id !== priorId).concat(cert.id);
      revoked.push(priorId);
      if (certificates.length > 1000 || Buffer.byteLength(JSON.stringify({ certificates,
        activeIds: nextActive, revokedIds: revoked, ownerPublicKeys: this.ownerPublicKeys,
        reviewerPublicKeys: this.reviewerPublicKeys, missEpochs: this.missEpochs() })) > 400 * 1024) {
        throw new Error('fixed registry snapshot over cap');
      }
      this.db.prepare(`UPDATE registry_state SET epoch=?,certificates_json=?,active_json=?,revoked_json=? WHERE singleton=1`)
        .run(row.epoch + 1, JSON.stringify(certificates), JSON.stringify(nextActive), JSON.stringify(revoked));
      this.db.prepare('INSERT INTO registry_renewals(prior_id,next_id) VALUES(?,?)').run(priorId, cert.id);
      return row.epoch + 1;
    })();
  }

  /** Revocation is monotonic. A repeated request returns the same epoch. */
  revoke(certificateId: string): number {
    return this.db.transaction(() => {
      const row = this.row();
      const active = JSON.parse(row.active_json) as string[];
      const revoked = JSON.parse(row.revoked_json) as string[];
      if (!active.includes(certificateId) && !revoked.includes(certificateId)) {
        throw new Error('fixed certificate does not exist');
      }
      // A delayed false-routine proof for a routinely retired certificate
      // invalidates every active renewal descended from that exact shape.
      const lineage = new Set<string>([certificateId]);
      let nextId = certificateId;
      while (true) {
        const edge = this.db.prepare('SELECT next_id FROM registry_renewals WHERE prior_id=?')
          .get(nextId) as { next_id: string } | undefined;
        if (!edge) break;
        if (lineage.has(edge.next_id)) throw new Error('fixed renewal lineage cycle');
        lineage.add(edge.next_id);
        nextId = edge.next_id;
      }
      const affected = active.filter(id => lineage.has(id));
      if (affected.length === 0) return row.epoch;
      const next = active.filter(id => !lineage.has(id));
      for (const id of affected) if (!revoked.includes(id)) revoked.push(id);
      this.db.prepare(`UPDATE registry_state SET epoch=?,active_json=?,revoked_json=? WHERE singleton=1`)
        .run(row.epoch + 1, JSON.stringify(next), JSON.stringify(revoked));
      return row.epoch + 1;
    })();
  }

  /** First accepted proof for one independent outcome suspends every active
   * certificate for the exact contract, including separately reissued ones.
   * Durable dedupe prevents replay from revoking a later reviewed recovery. */
  acceptFalseRoutineProof(proof: FixedRevocationProof): number {
    return this.db.transaction(() => {
      const row = this.row();
      const seen = this.db.prepare(`SELECT accepted_epoch FROM registry_accepted_misses
        WHERE source_machine_id=? AND attempt_id=? AND certificate_id=?`)
        .get(proof.sourceMachineId, proof.attemptId, proof.certificateId) as { accepted_epoch: number } | undefined;
      if (seen) return row.epoch;
      const certificates = JSON.parse(row.certificates_json) as FixedResultCertificate[];
      const target = certificates.find(cert => cert.id === proof.certificateId);
      if (!target) throw new Error('fixed certificate does not exist');
      const key = fixedContractKey(target);
      const active = JSON.parse(row.active_json) as string[];
      const revoked = JSON.parse(row.revoked_json) as string[];
      const affected = certificates.filter(cert => active.includes(cert.id) && fixedContractKey(cert) === key)
        .map(cert => cert.id);
      const affectedSet = new Set(affected);
      for (const id of affected) if (!revoked.includes(id)) revoked.push(id);
      if (!revoked.includes(target.id)) revoked.push(target.id);
      const nextEpoch = row.epoch + 1;
      this.db.prepare(`INSERT INTO registry_accepted_misses
        (source_machine_id,attempt_id,certificate_id,accepted_epoch) VALUES(?,?,?,?)`)
        .run(proof.sourceMachineId, proof.attemptId, proof.certificateId, nextEpoch);
      this.db.prepare(`INSERT INTO registry_contract_misses(contract_key,latest_epoch) VALUES(?,?)
        ON CONFLICT(contract_key) DO UPDATE SET latest_epoch=excluded.latest_epoch`).run(key, nextEpoch);
      this.db.prepare(`UPDATE registry_state SET epoch=?,active_json=?,revoked_json=? WHERE singleton=1`)
        .run(nextEpoch, JSON.stringify(active.filter(id => !affectedSet.has(id))), JSON.stringify(revoked));
      return nextEpoch;
    })();
  }

  snapshot(now = Date.now()): FixedCertificateRegistrySnapshot {
    const row = this.row();
    return signFixedRegistrySnapshot({ version: 1, authorityMachineId: this.authorityMachineId,
      epoch: row.epoch, issuedAt: new Date(now).toISOString(),
      certificates: JSON.parse(row.certificates_json) as FixedResultCertificate[],
      activeIds: JSON.parse(row.active_json) as string[],
      revokedIds: JSON.parse(row.revoked_json) as string[],
      ownerPublicKeys: { ...this.ownerPublicKeys }, reviewerPublicKeys: { ...this.reviewerPublicKeys },
      missEpochs: this.missEpochs() }, this.signer);
  }
}
