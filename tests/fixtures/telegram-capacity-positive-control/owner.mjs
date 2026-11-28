import { setTimeout as delay } from 'node:timers/promises';
import { OriginEgressCapacity, ORIGIN_CAPACITY_WINDOW_MS } from '../../../dist/messaging/telegram-origin/OriginEgressCapacity.js';
import { listenOriginNotices } from '../../../dist/messaging/telegram-origin/OriginNoticeIpc.js';
const capacity = new OriginEgressCapacity({ ownerBootId: 'isolated-owner', accountIds: () => ['123'], ownsLease: () => false });
await delay(ORIGIN_CAPACITY_WINDOW_MS);
let reserveCalls = 0, consumeCalls = 0;
const delegate = { reserve: (...a) => capacity.reserve(...a), consume: (...a) => capacity.consume(...a),
  reserveExplained: (...a) => { reserveCalls++; return capacity.reserveExplained(...a); },
  consumeExplained: (...a) => { consumeCalls++; return capacity.consumeExplained(...a); } };
const stop = await listenOriginNotices(process.argv[2], {}, () => [], delegate);
process.send({ ready: true, pid: process.pid });
let closing;
const close = () => closing ??= (async () => { await stop(); capacity.close(); })();
process.once('disconnect', () => { void close().catch(() => { process.exitCode = 1; }); });
if (!process.connected) { await close(); process.exitCode = 1; }
process.once('message', async message => {
  if (message !== 'close') throw new Error('invalid fixture close');
  await close();
  process.send({ stopped: true, reserveCalls, consumeCalls }, () => process.disconnect());
});
