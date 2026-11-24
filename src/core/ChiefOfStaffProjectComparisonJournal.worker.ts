import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { APP_CONVERSATION_KEY_RE } from './appConversationText.js';
import { boundProjects } from './ChiefOfStaffLoop.js';
import { CHIEF_OF_STAFF_RECORD_KIND, COS_LIFECYCLE_EVENTS, chiefOfStaffRecordStoreSchema, type UnionEntry } from './ChiefOfStaffStore.js';
import { validateReplicatedEnvelope } from './ReplicatedRecordEnvelope.js';
import { comparisonJournalFingerprint, type ChiefOfStaffComparisonKey, type ChiefOfStaffComparisonWorkerInput } from './ChiefOfStaffProjectComparisonJournal.js';

const counters = {
  bumpSchemaReject() {},
  bumpDroppedField() {},
  bumpJailReject() {},
};

function hasUnrotatedStream(input: ChiefOfStaffComparisonWorkerInput): boolean {
  const prefix = path.basename(input.file).replace(/\.jsonl$/, '.');
  const directory = fs.opendirSync(path.dirname(input.file));
  try {
    for (let count = 0; count <= input.directoryEntryLimit; count++) {
      const entry = directory.readSync();
      if (!entry) return true;
      if (entry.name.startsWith(prefix) && /^\d+\.jsonl$/.test(entry.name.slice(prefix.length))) return false;
    }
    return false;
  } finally {
    directory.closeSync();
  }
}

function readBoundedFile(input: ChiefOfStaffComparisonWorkerInput): Buffer | null {
  const fd = fs.openSync(input.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(input.byteLimit)
      || comparisonJournalFingerprint(stat) !== input.fingerprint) return null;
    const bytes = Buffer.alloc(Number(stat.size));
    let cursor = 0;
    while (cursor < bytes.length) {
      const count = fs.readSync(fd, bytes, cursor, bytes.length - cursor, cursor);
      if (count === 0) return null;
      cursor += count;
    }
    return comparisonJournalFingerprint(fs.fstatSync(fd, { bigint: true })) === input.fingerprint ? bytes : null;
  } finally {
    fs.closeSync(fd);
  }
}

function keysFromCurrentStream(input: ChiefOfStaffComparisonWorkerInput): ChiefOfStaffComparisonKey[] | null {
  if (!hasUnrotatedStream(input)) return null;
  const bytes = readBoundedFile(input);
  if (!bytes || bytes.at(-1) !== 10) return null;
  const entries: UnionEntry[] = [];
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let cursor = 0;
  for (let seq = 1; seq <= input.lastSeq; seq++) {
    const end = text.indexOf('\n', cursor);
    if (end < 0) return null;
    const line = JSON.parse(text.slice(cursor, end));
    cursor = end + 1;
    if (line?.seq !== seq || line.kind !== CHIEF_OF_STAFF_RECORD_KIND || line.machine !== input.machine) return null;
    const record = validateReplicatedEnvelope(line.data, chiefOfStaffRecordStoreSchema, counters);
    if (!record.ok || record.envelope.origin !== input.machine) return null;
    if (record.data.recordType === 'binding-lifecycle'
      && !COS_LIFECYCLE_EVENTS.some(event => event === record.data.event)) return null;
    entries.push({ origin: input.machine, data: record.data });
  }
  if (cursor !== text.length) return null;

  const projects = boundProjects(entries);
  if (projects.length > input.keyLimit) return null;
  const keys: ChiefOfStaffComparisonKey[] = [];
  for (const project of projects) {
    if (!project.conversationKey.startsWith('app:') || !APP_CONVERSATION_KEY_RE.test(project.conversationKey.slice(4))) return null;
    keys.push({ conversationKey: project.conversationKey, hasInitiativePointer: project.initiativeId !== undefined });
  }
  return keys;
}

try {
  parentPort?.postMessage(keysFromCurrentStream(workerData as ChiefOfStaffComparisonWorkerInput));
} catch {
  parentPort?.postMessage(null);
}
