/**
 * topic-memory-importer — idempotent import of Telegram messages into
 * .instar/topic-memory.db.
 *
 * Built 2026-05-20 after the local topic-memory.db was truncated to 4
 * messages during the Node 22→25 better-sqlite3 cascade recovery (incident
 * recorded in topic 10873). Bots cannot fetch Telegram history; only a
 * user-account MTProto session can. This module is the storage half of
 * that backfill path — gramjs fetches, this writes.
 *
 * The schema (read 2026-05-20 from a live agent home):
 *
 *   messages(id PK auto, message_id, topic_id, text, from_user, timestamp,
 *            session_name, sender_name, sender_username, telegram_user_id,
 *            user_id, privacy_scope, UNIQUE(message_id, topic_id))
 *
 * The UNIQUE(message_id, topic_id) constraint is the idempotency primitive.
 * `INSERT OR IGNORE` is the only sanctioned write path here — re-running
 * the importer against the same input is a no-op.
 *
 * Concurrency: the instar server (echo's own process) holds topic-memory.db
 * open under WAL mode. SQLite serializes writes across processes via WAL,
 * so this importer can write while the server is reading without
 * corruption. The FTS triggers maintain the FTS index automatically.
 */

import Database from 'better-sqlite3';

/**
 * @typedef {Object} BackfillMessage
 * @property {number} messageId         Telegram message id (per chat)
 * @property {number} topicId           Forum topic id (= message id of the
 *                                       topic-header message in the supergroup)
 * @property {string} text              Message text. Empty string for
 *                                       service messages / media-only.
 * @property {string} timestamp         ISO 8601 UTC
 * @property {number} [fromUser]        1 if message was sent by the user
 *                                       (justin), 0 if from any agent
 * @property {string} [senderName]      Display name
 * @property {string} [senderUsername]  @handle, no leading @
 * @property {number} [telegramUserId]  Numeric Telegram user id
 * @property {string} [userId]          instar user id, if known
 * @property {string} [sessionName]     instar session name, if known
 * @property {string} [privacyScope]    Defaults to 'private'
 */

/**
 * @typedef {Object} ImportResult
 * @property {number} inserted
 * @property {number} skipped
 * @property {Set<number>} touchedTopics
 */

export class TopicMemoryImporter {
  /**
   * @param {string} dbPath absolute path to topic-memory.db
   * @param {{ readonly?: boolean, journalMode?: 'wal' | 'delete' }} [opts]
   */
  constructor(dbPath, opts = {}) {
    this.db = new Database(dbPath, { readonly: opts.readonly ?? false });
    this.db.pragma(`journal_mode = ${opts.journalMode ?? 'wal'}`);
    this.db.pragma('busy_timeout = 5000');

    this._insert = this.db.prepare(`
      INSERT OR IGNORE INTO messages (
        message_id, topic_id, text, from_user, timestamp,
        session_name, sender_name, sender_username, telegram_user_id,
        user_id, privacy_scope
      ) VALUES (
        @messageId, @topicId, @text, @fromUser, @timestamp,
        @sessionName, @senderName, @senderUsername, @telegramUserId,
        @userId, @privacyScope
      )
    `);

    this._countByTopic = this.db.prepare(
      `SELECT topic_id, COUNT(*) AS n FROM messages GROUP BY topic_id`,
    );
  }

  close() {
    this.db.close();
  }

  /**
   * Import a batch of messages. All-or-nothing per call (wrapped in a
   * transaction). Safe to retry — the UNIQUE(message_id, topic_id)
   * constraint plus INSERT OR IGNORE means duplicates are silently dropped.
   *
   * @param {BackfillMessage[]} messages
   * @returns {ImportResult}
   */
  importBatch(messages) {
    const touched = new Set();
    let inserted = 0;
    let skipped = 0;
    const tx = this.db.transaction((batch) => {
      for (const m of batch) {
        const row = this._insert.run({
          messageId: m.messageId,
          topicId: m.topicId,
          text: m.text ?? '',
          fromUser: m.fromUser ?? 0,
          timestamp: m.timestamp,
          sessionName: m.sessionName ?? null,
          senderName: m.senderName ?? null,
          senderUsername: m.senderUsername ?? null,
          telegramUserId: m.telegramUserId ?? null,
          userId: m.userId ?? null,
          privacyScope: m.privacyScope ?? 'private',
        });
        if (row.changes === 1) inserted++;
        else skipped++;
        touched.add(m.topicId);
      }
    });
    tx(messages);
    return { inserted, skipped, touchedTopics: touched };
  }

  /**
   * Current message counts keyed by topic_id.
   * @returns {Map<number, number>}
   */
  countsByTopic() {
    const m = new Map();
    for (const row of this._countByTopic.all()) {
      m.set(row.topic_id, row.n);
    }
    return m;
  }
}
