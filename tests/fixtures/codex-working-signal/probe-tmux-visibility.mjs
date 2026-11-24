import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SafeFsExecutor } from '../../../dist/core/SafeFsExecutor.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'instar-mux-visibility-')));
const ordinary = join(root, 'ordinary.sock');
const isolated = join(root, 'isolated.sock');
const env = { PATH: process.env.PATH, HOME: root, TERM: 'xterm' };
const run = promisify(execFile);
const tmux = async (socket, ...args) =>
  (await run('tmux', ['-S', socket, '-f', '/dev/null', ...args], { env, timeout: 3000 })).stdout.trim();
const names = async socket => (await tmux(socket, 'list-sessions', '-F', '#{session_name}')).split('\n');
const panePid = (socket, name) => tmux(socket, 'display-message', '-p', '-t', '=' + name + ':', '#{pane_pid}');

try {
  await tmux(ordinary, 'new-session', '-d', '-s', 'ordinary', 'sleep', '25');
  await tmux(ordinary, 'new-session', '-d', '-s', 'candidate', 'sleep', '25');
  assert.deepEqual((await names(ordinary)).sort(), ['candidate', 'ordinary']);

  const candidatePid = await panePid(ordinary, 'candidate');
  assert.match(candidatePid, /^[1-9][0-9]*$/);
  await tmux(ordinary, 'rename-session', '-t', '=candidate', 'promoted');
  assert.equal(await panePid(ordinary, 'promoted'), candidatePid);

  await tmux(isolated, 'new-session', '-d', '-s', 'private-candidate', 'sleep', '25');
  assert.deepEqual(await names(isolated), ['private-candidate']);
  assert.deepEqual((await names(ordinary)).sort(), ['ordinary', 'promoted']);
  await assert.rejects(tmux(ordinary, 'move-window', '-s', 'private-candidate:0', '-t', 'ordinary:'));
  assert.deepEqual(await names(isolated), ['private-candidate']);
  assert.deepEqual((await names(ordinary)).sort(), ['ordinary', 'promoted']);

  console.log(JSON.stringify({
    sharedSocketListsCandidateBeforeRegistration: true,
    sameServerRenamePreservesPane: true,
    privateSocketHidesCandidateFromOrdinaryInventory: true,
    ordinaryMoveCannotResolveOtherServerWindow: true,
  }));
} finally {
  await Promise.allSettled([tmux(ordinary, 'kill-server'), tmux(isolated, 'kill-server')]);
  await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'tmux-visibility-fixture-cleanup' });
}
