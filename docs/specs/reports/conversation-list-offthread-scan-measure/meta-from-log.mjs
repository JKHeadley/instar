// Builds fixture-meta.json (topic ids and row positions only) from a COPY of a Telegram log.
import fs from 'node:fs';
const [log, out] = process.argv.slice(2); const rows = {}; const order = [];
for (const line of fs.readFileSync(log, 'utf8').split('\n')) { if (!line) continue; let e; try { e = JSON.parse(line); } catch { continue; } if (!e || typeof e !== 'object') continue;
  const id = e.topicId ?? e.channelId; if (typeof id !== 'number') continue; if (!rows[id]) { rows[id] = []; order.push(id); }
  rows[id].push({ messageId: e.messageId, fromUser: e.fromUser, atMs: Date.parse(e.timestamp), eventId: e.eventId ?? null }); }
fs.writeFileSync(out, JSON.stringify({ topics: order, rows })); console.log(JSON.stringify({ topics: order.length }));
