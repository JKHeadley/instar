import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseLocalSessionLines } from './localSessionParsers.js';
import type { LocalHistoryPreparedArtifactDescriptor } from './LocalHistoryPreparedArtifacts.js';

export const LOCAL_HISTORY_DISPOSABLE_PILOT_LINES = Object.freeze([
  JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session', cwd: '/synthetic/project' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'synthetic-user', role: 'user',
    content: [{ type: 'input_text', text: 'This is generated disposable copy pilot history.' }] } }),
]);

/** Only the built-in generated artifact can pass. Ordinary selected histories
 * cannot gain pilot eligibility by using a disposable directory. */
export function assertLocalHistoryDisposablePilotArtifact(owner: string, file: LocalHistoryPreparedArtifactDescriptor): void {
  const fixture = parseLocalSessionLines('codex', [...LOCAL_HISTORY_DISPOSABLE_PILOT_LINES]);
  const bytes = JSON.stringify(fixture);
  if (owner !== 'synthetic-owner' || file.source !== 'codex' || file.expectedSessionId !== 'synthetic-session'
    || file.projectPath !== '/synthetic/project' || file.representation !== fixture.representation
    || file.bytes !== Buffer.byteLength(bytes) || file.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Error('local-history-disposable-pilot-artifact');
  }
}

/** The pilot can only run in a named disposable test agent's private state. */
export function assertLocalHistoryDisposablePilotState(stateDir: string): void {
  const testHomes = path.join(fs.realpathSync(os.homedir()), '.instar', 'test-deploys');
  const home = path.dirname(stateDir);
  if (path.dirname(home) !== testHomes || path.basename(stateDir) !== '.instar'
    || !/^local-history-reserve-pilot-[a-f0-9]{32}$/.test(path.basename(home))
    || fs.realpathSync(stateDir) !== stateDir) throw new Error('local-history-disposable-pilot-state');
  const state = fs.lstatSync(stateDir);
  if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) {
    throw new Error('local-history-disposable-pilot-state');
  }
}
