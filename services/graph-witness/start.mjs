// Separate process and disk. This entry never enables a hierarchy read/write API.
import fs from 'node:fs';
import { createGraphWitnessServer } from '../../dist/server/graphWitnessServer.js';

const configPath = process.env.GRAPH_WITNESS_CONFIG_FILE;
if (!configPath) { console.error('Witness configuration is required.'); process.exit(1); }
const port = Number(process.env.PORT || '8094');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) { console.error('Witness port is invalid.'); process.exit(1); }
let runtime;
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.databasePath || !config.witnessId || !config.failureDomain || !config.signingPrivateKey
      || !config.enrollments || !Object.keys(config.enrollments).length || !Array.isArray(config.installedFailureDomains)) throw new Error('configuration');
  runtime = createGraphWitnessServer(config);
} catch {
  console.error('Witness configuration or durable storage could not be opened.'); process.exit(1);
}
const server = runtime.app.listen(port, '0.0.0.0', () => console.log('Witness service is listening.'));
server.on('error', () => { runtime.service.close(); console.error('Witness service could not listen.'); process.exit(1); });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  server.close(() => { runtime.service.close(); process.exit(0); });
  setTimeout(() => { server.closeAllConnections(); runtime.service.close(); process.exit(1); }, 10000).unref();
});
