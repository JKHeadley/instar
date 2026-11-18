import { randomBytes } from 'node:crypto';
import type { LiveConfig } from '../config/LiveConfig.js';

/**
 * identity-security-piece1h: the owner's "fix auth" reply. Creates a 32-byte key, checks that it
 * was saved (LiveConfig.set reports write failures only to the log), applies it to the running
 * config, and never echoes any part of it. Its own module so tests need not load the server.
 */
export function fixAuth(liveConfig: Pick<LiveConfig, 'get' | 'set'>, config: { authToken?: unknown }, otherMachines = 0): string {
  // The running server's key comes first: a key kept in the secret store shows as a placeholder in
  // the settings file even when it loaded fine.
  const running = config.authToken;
  if (typeof running === 'string' && running) return 'Your API already has a key. No changes needed.';
  if (running !== undefined && running !== null && running !== '') {
    return "Your API has a key, but it is kept in the secret store and could not be loaded. I left it alone; the server keeps retrying the store and will tell you if that doesn't work.";
  }
  if (liveConfig.get<unknown>('authToken', '')) return 'Your API already has a key in its settings. No changes needed.';
  if (otherMachines > 0) {
    // A key on one machine alone would refuse its peers' calls (they carry the agent key).
    return `This agent runs on ${otherMachines + 1} machines, and they must share one API key, so I haven't set one here alone. `
      + 'Ask your agent to "set up the API key on every machine" and it will set the same key on all of them at once.';
  }
  const token = randomBytes(32).toString('hex');
  liveConfig.set('authToken', token);
  if (liveConfig.get<unknown>('authToken', '') !== token) {
    return "I couldn't save a new key: writing the agent's settings failed. Nothing changed, and your API is still open. I'll look into why the write failed.";
  }
  config.authToken = token;
  return 'Done. Your agent now has an API key, and its API refuses callers without it. '
    + 'Your Telegram and Slack relays pick the key up on their own. Sessions that were already running use it after they restart.';
}
