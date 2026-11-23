import net from 'node:net';
import { holdLocalHistoryChild } from '../../../dist/import/LocalHistoryChildCustody.js';

process.once('message', ({ token, socketPath }) => {
  const holder = holdLocalHistoryChild(token);
  const server = net.createServer(socket => {
    socket.once('data', bytes => {
      if (bytes.toString() !== 'release' || !holder.active()) { socket.destroy(); return; }
      socket.end('exiting');
      // Keep the shared custody read transaction until actual process exit.
      server.close(() => process.exit(0));
    });
  });
  server.listen(socketPath, () => { process.send?.({ ready: true }); process.disconnect(); });
});
