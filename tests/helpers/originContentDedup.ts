import { OutboundContentDedup } from '../../src/messaging/OutboundContentDedup.js';
import { SqliteOutboundDedupStore } from '../../src/messaging/OutboundDedupStore.js';
import { originContentDedup } from '../../src/messaging/telegram-origin/OriginContentDedup.js';

/** Isolated transports retain the real durable content authority. */
export function fixtureOriginContentDedup(stateDir: string, chatId = '-100123') {
  return originContentDedup(new OutboundContentDedup({}, Date.now,
    new SqliteOutboundDedupStore(SqliteOutboundDedupStore.defaultPath(stateDir))), chatId);
}
