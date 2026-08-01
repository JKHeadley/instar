#!/usr/bin/env node
/**
 * Read-only replay of CorrectionAnalyzer against an existing correction ledger.
 *
 * Usage (after `pnpm build`):
 *   node scripts/correction-promotion-corpus-replay.mjs /path/to/correction-ledger.db
 *
 * The script never opens the database for writing and never prints learning text.
 */
import Database from 'better-sqlite3';
import {
  CorrectionAnalyzer,
  DEFAULT_CORRECTION_GATES,
  DEFAULT_CORRECTION_SIMILARITY_THRESHOLD,
  clusterCorrectionRecords,
  correctionLearningSimilarity,
} from '../dist/monitoring/CorrectionAnalyzer.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: correction-promotion-corpus-replay.mjs <correction-ledger.db>');
  process.exitCode = 2;
} else {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const occurrenceColumns = db
      .prepare(`PRAGMA table_info(correction_occurrences)`)
      .all()
      .map((column) => column.name);
    const occurrenceSessionExpr = occurrenceColumns.includes('session_id')
      ? 'COALESCE(o.session_id, r.session_id)'
      : 'r.session_id';

    const records = db
      .prepare(
        `SELECT id, dedupe_key, kind, occurrence_count, detected_at, learning,
                scrubbed_summary, day_bucket, deterministic_weight, llm_confidence,
                topic_id, session_id, status, routed_via, verify_window_start,
                verify_window_end, reopen_count, created_at, updated_at, version
           FROM correction_records
          ORDER BY detected_at DESC`,
      )
      .all()
      .map(rowToRecord);

    const ledger = {
      list(filter = {}) {
        return records.filter((record) => {
          if (filter.status && record.status !== filter.status) return false;
          if (filter.kind && record.kind !== filter.kind) return false;
          if (filter.sinceMs && Date.parse(record.detectedAt) < filter.sinceMs) return false;
          return true;
        }).slice(0, filter.limit ?? 100);
      },
      distinctCounts(dedupeKeyOrKeys, weightThreshold = 0) {
        const keys = typeof dedupeKeyOrKeys === 'string'
          ? [dedupeKeyOrKeys]
          : [...new Set(dedupeKeyOrKeys)];
        if (keys.length === 0) {
          return {
            qualifyingOccurrences: 0,
            distinctDays: 0,
            distinctTopics: 0,
            distinctSessions: 0,
          };
        }
        const placeholders = keys.map(() => '?').join(', ');
        const rows = db
          .prepare(
            `SELECT o.day_bucket AS dayBucket,
                    o.topic_id AS topicId,
                    ${occurrenceSessionExpr} AS sessionId
               FROM correction_occurrences o
               LEFT JOIN correction_records r ON r.dedupe_key = o.dedupe_key
              WHERE o.dedupe_key IN (${placeholders})
                AND o.deterministic_weight >= ?`,
          )
          .all(...keys, weightThreshold);
        return {
          qualifyingOccurrences: rows.length,
          distinctDays: distinctNonNull(rows.map((row) => row.dayBucket)),
          distinctTopics: distinctNonNull(rows.map((row) => row.topicId)),
          distinctSessions: distinctNonNull(rows.map((row) => row.sessionId)),
        };
      },
    };

    const analyzer = new CorrectionAnalyzer(ledger);
    const result = analyzer.analyze();
    const candidateThresholds = [0.5, 0.55, 0.6, 0.65, 0.7].map((threshold) => {
      const clusters = clusterCorrectionRecords(
        records.filter((record) => record.status === 'open' && record.kind !== 'noise'),
        threshold,
      );
      return {
        threshold,
        clusterCount: clusters.length,
        multiRecordClusterSizes: clusters.filter((cluster) => cluster.length > 1).map((cluster) => cluster.length),
        minimumWithinClusterSimilarity: minimumWithinMultiRecordClusters(clusters),
      };
    });
    const selectedClusters = clusterCorrectionRecords(
      records.filter((record) => record.status === 'open' && record.kind !== 'noise'),
      DEFAULT_CORRECTION_SIMILARITY_THRESHOLD,
    );

    console.log(JSON.stringify({
      dbPath,
      openedReadOnly: true,
      rows: records.length,
      selectedThreshold: DEFAULT_CORRECTION_SIMILARITY_THRESHOLD,
      candidateThresholds,
      strongestExcludedSameKindSimilarity: strongestExcludedSameKindSimilarity(selectedClusters),
      result: {
        consideredRecords: result.considered,
        clusterCount: result.verdicts.length,
        crossedCount: result.crossed.length,
        multiRecordClusters: result.verdicts
          .filter((verdict) => verdict.clusterRecords.length > 1)
          .map((verdict) => ({
            kind: verdict.record.kind,
            size: verdict.clusterRecords.length,
            ids: verdict.clusterRecords.map((record) => record.id),
            support: verdict.qualifyingOccurrences,
            days: verdict.distinctDays,
            sessions: verdict.distinctSessions,
            crosses: verdict.crosses,
            reason: verdict.reason,
          })),
      },
      gates: DEFAULT_CORRECTION_GATES,
    }, null, 2));
  } finally {
    db.close();
  }
}

function distinctNonNull(values) {
  return new Set(values.filter((value) => value !== null && value !== undefined && value !== '')).size;
}

function minimumWithinMultiRecordClusters(clusters) {
  const similarities = [];
  for (const cluster of clusters) {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        similarities.push(correctionLearningSimilarity(cluster[i].learning, cluster[j].learning));
      }
    }
  }
  return similarities.length > 0 ? Math.min(...similarities) : null;
}

function strongestExcludedSameKindSimilarity(clusters) {
  let strongest = null;
  for (let left = 0; left < clusters.length; left++) {
    for (let right = left + 1; right < clusters.length; right++) {
      if (clusters[left][0].kind !== clusters[right][0].kind) continue;
      for (const a of clusters[left]) {
        for (const b of clusters[right]) {
          const similarity = correctionLearningSimilarity(a.learning, b.learning);
          if (strongest === null || similarity > strongest) strongest = similarity;
        }
      }
    }
  }
  return strongest;
}

function rowToRecord(row) {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    occurrenceCount: row.occurrence_count,
    detectedAt: row.detected_at,
    learning: row.learning,
    scrubbedSummary: row.scrubbed_summary,
    dayBucket: row.day_bucket,
    deterministicWeight: row.deterministic_weight,
    llmConfidence: row.llm_confidence,
    topicId: row.topic_id,
    sessionId: row.session_id,
    status: row.status,
    routedVia: row.routed_via ?? undefined,
    verifyWindowStart: row.verify_window_start ?? undefined,
    verifyWindowEnd: row.verify_window_end ?? undefined,
    reopenCount: row.reopen_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
