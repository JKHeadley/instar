import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function getTelegramInboundDir(projectDir: string): string {
  return path.join(projectDir, '.instar', 'telegram-inbound');
}

/**
 * Create the inbound folder owner-only, and tighten it when it already exists, is ours, and has
 * group or other bits (older builds made it with the default mode). With the folder at 0700, no
 * other account can list or open anything inside, whatever mode an individual file has.
 */
export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const st = fs.lstatSync(dir);
    if (st.isDirectory() && typeof process.getuid === 'function' && st.uid === process.getuid() && (st.mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700);
    }
  } catch { /* @silent-fallback-ok — files written by writePrivateInboundFile are still 0600 */ }
  return dir;
}

/**
 * SEC-138: save an inbound message body for a session to read, inside the agent's own project
 * folder rather than a fixed shared folder under /tmp. A shared /tmp folder is readable by every
 * local account and can be pre-created by one of them, which could then read the body or swap the
 * file before the session opens it. The project-local inbound folder is the one Telegram already
 * uses: sandboxed sessions can read it, git sync skips it, and the memory-privacy staging knows it.
 *
 * The folder is created owner-only, the file is created owner-only and exclusively (`wx`), and the
 * name carries a random part, so two messages in the same millisecond never collide.
 */
export function writePrivateInboundFile(projectDir: string, prefix: string, content: string): string {
  const dir = ensurePrivateDir(getTelegramInboundDir(projectDir));
  const safePrefix = prefix.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60) || 'msg';
  const filepath = path.join(dir, `${safePrefix}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
  fs.writeFileSync(filepath, content, { mode: 0o600, flag: 'wx' });
  return filepath;
}
