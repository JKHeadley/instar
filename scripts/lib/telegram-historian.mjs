/**
 * TelegramHistorian — gramjs-based MTProto backfill for instar topic-memory.
 *
 * Built 2026-05-20 in response to topic 10873 incident: Echo's
 * topic-memory.db was truncated during a Node 22→25 native-module cascade,
 * losing the local mirror of multiple Telegram topics. Telegram's Bot API
 * is forward-only — bots cannot fetch chat history. A user-account MTProto
 * session can. This module is the gramjs half of the recovery path.
 *
 * Authority posture (read carefully before extending):
 *   - This module authenticates AS the operator's Telegram account. It is
 *     not a bot. It can read everything the operator's account can read,
 *     including DMs and private groups. That power requires discipline.
 *   - Permitted operations: iterMessages (read), getDialogs (read),
 *     getMessages (read). No send/edit/delete is ever issued from here.
 *   - The session string is the long-lived credential. It must live behind
 *     mode-0600 file permissions, outside any git-tracked path, and be
 *     migrated into a real secret store as soon as one is available.
 *   - Auth requires interactive SMS code entry by the operator. The
 *     onCode/onPassword callbacks here are the only interactive surface.
 *
 * Forum topics: in a Telegram forum supergroup, each topic is identified
 * by the message id of its topic-header message. Replies and posts in a
 * topic carry reply_to.forum_topic = true and reply_to.reply_to_top_id =
 * <topic_id>. gramjs surfaces this via the `replyTo` option to
 * iterMessages — a value matching the topic id filters to that topic.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} HistorianCredentials
 * @property {number} apiId
 * @property {string} apiHash
 * @property {string} sessionFilePath  Absolute path to the session string file
 */

/**
 * @typedef {Object} AuthPrompts
 * @property {() => Promise<string>} onPhoneNumber       Required if no saved session
 * @property {() => Promise<string>} onCode              Required if no saved session
 * @property {() => Promise<string>} [onPassword]        Optional 2FA password
 * @property {(error: Error) => void} [onError]
 */

const CONNECTION_RETRIES = 5;

export class TelegramHistorian {
  /**
   * @param {HistorianCredentials} creds
   * @param {{ verbose?: boolean }} [opts]
   */
  constructor(creds, opts = {}) {
    this.creds = creds;
    this.verbose = opts.verbose ?? false;
    this.client = null;
  }

  _loadSavedSession() {
    if (!this.creds.sessionFilePath) return '';
    if (!fs.existsSync(this.creds.sessionFilePath)) return '';
    return fs.readFileSync(this.creds.sessionFilePath, 'utf8').trim();
  }

  _saveSession(sessionStr) {
    if (!this.creds.sessionFilePath) return;
    fs.mkdirSync(path.dirname(this.creds.sessionFilePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.creds.sessionFilePath, sessionStr, { mode: 0o600 });
  }

  /**
   * Connect and authenticate. If a saved session string exists at
   * creds.sessionFilePath, reuses it (no SMS needed). Otherwise drives
   * the interactive auth flow through the provided callbacks.
   *
   * @param {AuthPrompts} prompts
   */
  async connect(prompts) {
    const saved = this._loadSavedSession();
    const session = new StringSession(saved);
    this.client = new TelegramClient(session, this.creds.apiId, this.creds.apiHash, {
      connectionRetries: CONNECTION_RETRIES,
    });

    await this.client.start({
      phoneNumber: prompts.onPhoneNumber,
      phoneCode: prompts.onCode,
      password: prompts.onPassword ?? (async () => {
        throw new Error('2FA password required but no onPassword callback provided');
      }),
      onError: prompts.onError ?? ((err) => {
        // eslint-disable-next-line no-console
        console.error('[TelegramHistorian] auth error:', err.message);
      }),
    });

    const sessionStr = this.client.session.save();
    if (sessionStr && sessionStr !== saved) {
      this._saveSession(sessionStr);
      if (this.verbose) {
        // eslint-disable-next-line no-console
        console.error('[TelegramHistorian] session saved to', this.creds.sessionFilePath);
      }
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  _ensureConnected() {
    if (!this.client) throw new Error('TelegramHistorian: not connected — call connect() first');
  }

  /**
   * Resolve a supergroup reference (numeric id like -1003742343280, or
   * @username) to a gramjs entity.
   * @param {string | number | bigint} chatRef
   */
  async resolveChat(chatRef) {
    this._ensureConnected();
    return await this.client.getEntity(chatRef);
  }

  /**
   * List forum topics in a supergroup. Returns each topic's id, title, and
   * top_message id.
   * @param {string | number | bigint} chatRef
   * @returns {Promise<Array<{ id: number, title: string, topMessageId: number, closed: boolean }>>}
   */
  async listForumTopics(chatRef) {
    this._ensureConnected();
    const entity = await this.resolveChat(chatRef);
    const result = await this.client.invoke(
      new Api.channels.GetForumTopics({
        channel: entity,
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 100,
      }),
    );
    const topics = [];
    for (const t of result.topics) {
      // ForumTopic vs ForumTopicDeleted
      if (t.className === 'ForumTopic') {
        topics.push({
          id: Number(t.id),
          title: t.title,
          topMessageId: Number(t.topMessage ?? t.id),
          closed: Boolean(t.closed),
        });
      }
    }
    return topics;
  }

  /**
   * Iterate all messages in a single forum topic, oldest-first. Yields
   * one BackfillMessage at a time. Handles FloodWait via gramjs's
   * built-in retry. Caller is responsible for importing.
   *
   * @param {string | number | bigint} chatRef
   * @param {number} topicId  forum topic id
   * @param {{ minMessageId?: number, batchSize?: number }} [opts]
   */
  async *iterTopicMessages(chatRef, topicId, opts = {}) {
    this._ensureConnected();
    const entity = await this.resolveChat(chatRef);
    const batchSize = opts.batchSize ?? 100;
    const minMessageId = opts.minMessageId ?? 0;

    const iter = this.client.iterMessages(entity, {
      replyTo: topicId,
      limit: undefined,
      reverse: true,
      minId: minMessageId,
      filter: undefined,
    });

    let pageCount = 0;
    let yielded = 0;
    for await (const msg of iter) {
      if (!msg) continue;
      const text = typeof msg.message === 'string' ? msg.message : '';
      const sender = msg.sender ?? null;
      const fromUser = msg.out === true ? 1 : 0;
      const ts = new Date(Number(msg.date) * 1000).toISOString();

      yield {
        messageId: Number(msg.id),
        topicId,
        text,
        timestamp: ts,
        fromUser,
        senderName: sender?.firstName
          ? [sender.firstName, sender.lastName].filter(Boolean).join(' ')
          : null,
        senderUsername: sender?.username ?? null,
        telegramUserId: sender?.id != null ? Number(sender.id) : null,
        userId: null,
        sessionName: null,
        privacyScope: 'private',
      };
      yielded++;
      if (yielded % batchSize === 0) {
        pageCount++;
        if (this.verbose) {
          // eslint-disable-next-line no-console
          console.error(
            `[TelegramHistorian] topic ${topicId}: page ${pageCount} (${yielded} so far)`,
          );
        }
      }
    }
  }
}
