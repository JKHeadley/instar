// Compare private receipts from an authorized, paused capture. This command cannot enroll a board.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [manifestPath, evidenceDir] = process.argv.slice(2);
const digestPattern = /^[a-f0-9]{64}$/;
const emptyProjectionDigest = createHash('sha256').update(JSON.stringify(['work-board-starting-history-v1', []])).digest('hex');
const machinePattern = /^m_[a-f0-9]{32}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sequence = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.length > 0;
const mapEntries = (value) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const require = (condition, reason) => { if (!condition) throw new Error(reason); };
const read = (file, label) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`unreadable ${label}`); }
};

function ownerTuple(receipt, label) {
  require(receipt?.ready === true && receipt.health === 'ok' && text(receipt.ownerPersonKey)
    && Array.isArray(receipt.gaps) && receipt.gaps.length === 0, `owner receipt unavailable for ${label}`);
  require(record(receipt.heads) && record(receipt.vector), `invalid owner heads or vector for ${label}`);
  const heads = mapEntries(receipt.heads);
  const vector = mapEntries(receipt.vector);
  require(heads.length > 0 && same(heads.map(([id]) => id), vector.map(([id]) => id))
    && heads.every(([, value]) => typeof value === 'string' && digestPattern.test(value))
    && vector.every(([, value]) => sequence(value)), `invalid owner stream evidence for ${label}`);
  return [receipt.ownerPersonKey, heads, vector];
}

function historyTuple(receipt, machineId, frozenHeads) {
  const head = frozenHeads[machineId];
  require(receipt?.machineId === machineId && receipt.ownIncarnation === head.incarnation
    && receipt.ownLastSeq === head.lastSeq, `frozen journal head mismatch for ${machineId}`);
  require(typeof receipt.projectionDigest === 'string' && digestPattern.test(receipt.projectionDigest)
    && Array.isArray(receipt.origins), `invalid history receipt for ${machineId}`);
  const seen = new Set();
  const origins = receipt.origins.map((row) => {
    require(record(row) && typeof row.origin === 'string' && machinePattern.test(row.origin)
      && !seen.has(row.origin) && sequence(row.count) && row.count > 0
      && typeof row.digest === 'string' && digestPattern.test(row.digest), `invalid origin rows for ${machineId}`);
    const originHead = frozenHeads[row.origin];
    require(!originHead || row.count <= originHead.lastSeq, `origin count exceeds frozen head for ${machineId}`);
    seen.add(row.origin);
    return [row.origin, row.count, row.digest];
  }).sort(([a], [b]) => a.localeCompare(b));
  require(seen.has(machineId) === (head.lastSeq > 0), `local origin coverage mismatch for ${machineId}`);
  require((origins.length === 0) === (receipt.projectionDigest === emptyProjectionDigest),
    `empty projection digest mismatch for ${machineId}`);
  return [receipt.projectionDigest, origins];
}

try {
  require(manifestPath && evidenceDir, 'usage: compare-work-board-capture.mjs MANIFEST EVIDENCE_DIR');
  const manifest = read(manifestPath, 'frozen manifest');
  require(Array.isArray(manifest?.roster) && manifest.roster.length > 0
    && manifest.roster.every((id) => typeof id === 'string' && machinePattern.test(id)), 'invalid frozen roster');
  const roster = [...new Set(manifest.roster)].sort();
  require(roster.length === manifest.roster.length && record(manifest.heads)
    && same(Object.keys(manifest.heads).sort(), roster), 'frozen heads do not cover the exact roster');
  for (const id of roster) {
    const head = manifest.heads[id];
    require(record(head) && text(head.incarnation) && sequence(head.lastSeq), `invalid frozen head for ${id}`);
  }
  let ownerReference;
  let historyReference;
  for (const id of roster) {
    for (const phase of ['before', 'after']) {
      const name = `${id}.team-owner.${phase}.json`;
      const value = ownerTuple(read(path.join(evidenceDir, name), name), `${id} ${phase}`);
      ownerReference ??= value;
      require(same(ownerReference, value), `owner evidence mismatch for ${id} ${phase}`);
    }
    const name = `${id}.work-board.json`;
    const value = historyTuple(read(path.join(evidenceDir, name), name), id, manifest.heads);
    historyReference ??= value;
    require(same(historyReference, value), `Work Board history mismatch for ${id}`);
  }
  console.log(JSON.stringify({
    receiptsMatch: true,
    homes: roster,
    projectionDigest: historyReference[0],
    originCount: historyReference[1].length,
  }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
