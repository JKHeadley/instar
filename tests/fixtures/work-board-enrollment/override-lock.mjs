// Verify the compiled candidate cannot claim exclusive authority beside a live holder.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, stateDir] = process.argv.slice(2);
const moduleUrl = pathToFileURL(path.resolve(dist, 'core', 'SingleInstanceLock.js')).href;
const { SingleInstanceLock } = await import(moduleUrl);
const lock = new SingleInstanceLock({ stateDir, env: { INSTAR_ALLOW_SECOND_INSTANCE: '1' } });
try {
  const result = await lock.acquire();
  process.stdout.write(JSON.stringify({ ...result, exclusive: lock.revalidateExclusive() }));
} finally {
  lock.release();
}
