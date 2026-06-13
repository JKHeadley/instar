// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * WS2.4 — KnowledgeManager knowledge-record replication emit seam.
 *
 * Wiring-integrity + the spec-critical remove-tombstone-resurrection test:
 *   - dark by default: with NO emitter injected, ingest()/remove() emit nothing (a strict
 *     single-machine no-op, byte-identical local behavior).
 *   - emit-on-ingest: an injected emitter receives a `put` for the ingested source.
 *   - REMOVE EMITS TOMBSTONE: remove() emits an `op:delete` tombstone keyed on the
 *     removed source's content fingerprint — else a peer re-replicates a locally-removed
 *     source forever (resurrection). This is the named §3 gate.
 *   - emit is best-effort: a throwing emitter NEVER breaks the local write (the durable
 *     catalog is still persisted).
 *   - detach returns to a single-machine no-op.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { KnowledgeManager, type KnowledgeReplicationEmitter } from '../../src/knowledge/KnowledgeManager.js';

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-repl-'));
}
function cleanup(dir: string) {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/knowledge-manager-replication.test.ts' });
}

interface Recorder extends KnowledgeReplicationEmitter {
  puts: string[];
  deletes: Array<{ title: string; url: string | null; type: string }>;
}
function recorder(over: Partial<KnowledgeReplicationEmitter> = {}): Recorder {
  const r: Recorder = {
    puts: [],
    deletes: [],
    emitPut(record) { r.puts.push(record.title); },
    emitDelete(title, url, type) { r.deletes.push({ title, url, type }); },
    ...over,
  };
  return r;
}

describe('KnowledgeManager knowledge-record replication emit', () => {
  it('dark by default: NO emitter ⇒ ingest()/remove() emit nothing (strict no-op)', () => {
    const dir = mkDir();
    try {
      const km = new KnowledgeManager(dir);
      // No setKnowledgeReplicationEmitter call. ingest must not throw + must persist.
      const res = km.ingest('some content here', { title: 'a source', url: 'https://example.com/a' });
      expect(res.sourceId).toMatch(/^kb_/);
      expect(km.getCatalog()).toHaveLength(1);
      // remove must also not throw with no emitter.
      expect(km.remove(res.sourceId)).toBe(true);
      expect(km.getCatalog()).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('emit-on-ingest: an injected emitter receives a put for the ingested source', () => {
    const dir = mkDir();
    try {
      const km = new KnowledgeManager(dir);
      const rec = recorder();
      km.setKnowledgeReplicationEmitter(rec);
      km.ingest('content', { title: 'OpenClaw analysis', url: 'https://example.com/openclaw' });
      expect(rec.puts).toContain('OpenClaw analysis');
      expect(rec.deletes).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('REMOVE EMITS TOMBSTONE: remove() emits op:delete keyed on the removed source (no resurrection)', () => {
    const dir = mkDir();
    try {
      const km = new KnowledgeManager(dir);
      const rec = recorder();
      km.setKnowledgeReplicationEmitter(rec);
      const res = km.ingest('content', { title: 'to be removed', url: 'https://example.com/gone', type: 'transcript' });
      rec.puts.length = 0; rec.deletes.length = 0;
      expect(km.remove(res.sourceId)).toBe(true);
      // The tombstone fired for the removed source's stable identity (title/url/type).
      expect(rec.deletes).toHaveLength(1);
      expect(rec.deletes[0]).toEqual({ title: 'to be removed', url: 'https://example.com/gone', type: 'transcript' });
    } finally {
      cleanup(dir);
    }
  });

  it('remove of a non-existent source emits NO tombstone (nothing was removed)', () => {
    const dir = mkDir();
    try {
      const km = new KnowledgeManager(dir);
      const rec = recorder();
      km.setKnowledgeReplicationEmitter(rec);
      expect(km.remove('kb_nonexistent')).toBe(false);
      expect(rec.deletes).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('emit is best-effort: a throwing emitter NEVER breaks the local write', () => {
    const dir = mkDir();
    try {
      const km = new KnowledgeManager(dir);
      km.setKnowledgeReplicationEmitter({
        emitPut() { throw new Error('replication down'); },
        emitDelete() { throw new Error('replication down'); },
      });
      // The ingest must still persist despite the throwing emitter.
      const res = km.ingest('content', { title: 'resilient', url: 'https://example.com/r' });
      expect(res.sourceId).toMatch(/^kb_/);
      expect(km.getCatalog().map((s) => s.title)).toContain('resilient');
      // And remove must still persist despite the throwing emitter.
      expect(km.remove(res.sourceId)).toBe(true);
      expect(km.getCatalog()).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('detach: passing undefined returns to single-machine no-op', () => {
    const dir = mkDir();
    try {
      const km = new KnowledgeManager(dir);
      const rec = recorder();
      km.setKnowledgeReplicationEmitter(rec);
      km.setKnowledgeReplicationEmitter(undefined);
      km.ingest('content', { title: 'detached', url: 'https://example.com/d' });
      expect(rec.puts).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});
