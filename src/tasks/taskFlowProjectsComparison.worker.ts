import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

interface Input {
  databasePath: string;
  sqliteModule: string;
  controllerId: string;
  maxInputRows: number;
  maxInputBytes: number;
  maxProjectRows: number;
}

interface Row {
  flow_id: string;
  privacy_scope: string | null;
  bytes: number;
  state_json: string | null;
}

function projectRows(input: Input) {
  // A live owner with existing sidecars keeps this a reader of the current WAL.
  // Never open an immutable or copied database that could omit accepted writes.
  let backingBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const stat = fs.lstatSync(input.databasePath + suffix);
    if (!stat.isFile()) return null;
    backingBytes += stat.size;
    // Bound pager/WAL open work as well as the candidate bytes below.
    if (backingBytes > input.maxInputBytes) return null;
  }
  const Database = createRequire(import.meta.url)(input.sqliteModule) as typeof import('better-sqlite3');
  const db = new Database(input.databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const query = db.prepare<[number, string, number], Row>(`
      SELECT flow_id, privacy_scope, coalesce(length(CAST(state_json AS BLOB)), 0) AS bytes,
        CASE WHEN length(CAST(state_json AS BLOB)) <= ? THEN state_json ELSE NULL END AS state_json
      FROM flows INDEXED BY flows_controller_status WHERE controller_id = ? LIMIT ?
    `);
    let count = 0;
    let remaining = input.maxInputBytes;
    const items: Array<{ id: string; title: string }> = [];
    const ids = new Set<string>();
    for (const row of query.iterate(input.maxInputBytes, input.controllerId, input.maxInputRows + 1)) {
      const charge = row.bytes + Buffer.byteLength(row.flow_id) + Buffer.byteLength(row.privacy_scope ?? '');
      if (++count > input.maxInputRows || charge > remaining || row.privacy_scope !== null) return null;
      remaining -= charge;
      if (row.state_json === null) {
        if (row.bytes !== 0) return null;
        continue;
      }
      const state = JSON.parse(row.state_json) as { _removed?: boolean; initiative?: { id?: unknown; kind?: unknown; title?: unknown } } | null;
      const initiative = state?.initiative;
      if (state?._removed === true || initiative?.kind !== 'project') continue;
      if (typeof initiative.id !== 'string' || !initiative.id || typeof initiative.title !== 'string' || ids.has(initiative.id)) return null;
      ids.add(initiative.id);
      items.push({ id: initiative.id, title: initiative.title });
      if (items.length > input.maxProjectRows) {
        items.pop();
        return { coverage: 'partial', items, relationsComplete: false } as const;
      }
    }
    return { coverage: 'complete', items, relationsComplete: false } as const;
  } finally {
    db.close();
  }
}

try {
  parentPort?.postMessage(projectRows(workerData as Input));
} catch {
  parentPort?.postMessage(null);
}
