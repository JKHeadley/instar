// Called by the commitment-detection prompt. The caller acknowledges a batch
// only after it has examined the messages and registered the resulting actions.
import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.INSTAR_STATE_DIR || path.join(process.env.INSTAR_AGENT_HOME || process.cwd(), '.instar');
const bookmark = path.join(stateDir, 'state', 'commitment-detection-bookmark.json');

function readBookmark() {
  let raw;
  try {
    raw = fs.readFileSync(bookmark, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lastProcessedId: 0 };
    throw err;
  }
  const saved = JSON.parse(raw);
  if (!Number.isSafeInteger(saved?.lastProcessedId) || saved.lastProcessedId < 0) {
    throw new Error('invalid lastProcessedId in commitment-detection bookmark');
  }
  return saved;
}

async function readBatch() {
  const { lastProcessedId } = readBookmark();
  const env = process.env;
  const config = env.INSTAR_PORT && env.INSTAR_AGENT_ID && env.INSTAR_AUTH_TOKEN
    ? {} : JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
  const token = env.INSTAR_AUTH_TOKEN || config.authToken;
  const agentId = env.INSTAR_AGENT_ID || config.projectName;
  const port = Number(env.INSTAR_PORT || config.port);
  if (typeof token !== 'string' || !token || !agentId || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('local server port, agent ID and resolved auth token required');
  }
  const response = await fetch(`http://127.0.0.1:${port}/telegram/search?recent=1&limit=100`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Instar-AgentId': agentId },
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`Telegram history HTTP ${response.status}: ${detail.reason || detail.error || response.statusText}`);
  }
  const { results, count } = await response.json();
  if (!Array.isArray(results) || count !== results.length || count > 100 ||
      results.some(row => !Number.isSafeInteger(row?.messageId) || row.messageId < 1 || typeof row.text !== 'string')) {
    throw new Error('invalid Telegram history response');
  }
  const messages = results.filter(row => row.messageId > lastProcessedId);
  return { messages, through: Math.max(lastProcessedId, ...messages.map(row => row.messageId)) };
}

function advance(through) {
  if (!Number.isSafeInteger(through) || through < 1) throw new Error('expected a positive processed message ID');
  fs.mkdirSync(path.dirname(bookmark), { recursive: true });
  // The exclusive staging file serializes even overlapping acknowledgements.
  // Renaming releases it and publishes a complete bookmark in one operation.
  const pending = bookmark + '.pending';
  let published = false;
  const fd = fs.openSync(pending, 'wx');
  try {
    try {
      const saved = readBookmark();
      if (through <= saved.lastProcessedId) return;
      fs.writeFileSync(fd, JSON.stringify({ ...saved, lastProcessedId: through }) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(pending, bookmark);
    published = true;
    console.log('EFFECT: .instar/state/commitment-detection-bookmark.json');
  } finally {
    if (!published) fs.unlinkSync(pending);
  }
}

try {
  const [command, id] = process.argv.slice(2);
  if (command === 'read') console.log(JSON.stringify(await readBatch()));
  else if (command === 'advance') advance(Number(id));
  else throw new Error('expected read or advance <processed message ID>');
} catch (err) {
  console.error(`Commitment detection ${process.argv[2] || 'history'} failed: ${err.message}`);
  process.exitCode = 1;
}
