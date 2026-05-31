/**
 * Agent hard-sleep wake-trigger helper (Stage B mechanism). Pure + testable,
 * shared by the TelegramLifeline forward path. When the ServerSupervisor has
 * intentionally slept the server, a `state/slept-marker.json` is on disk; an
 * inbound message is the wake trigger, so the lifeline writes
 * `state/wake-requested.json` for the supervisor to honor (it respawns the server,
 * consumes the flag, and removes the marker). The buffered message replays via the
 * existing forward-retry queue once the server is healthy — zero loss.
 *
 * Idempotent + cheap: steady-state (server awake, no marker) this is a single
 * existsSync no-op. Best-effort: a failed write just delays the wake one tick,
 * since the lifeline calls this on every forward attempt while a marker persists.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * If a slept-marker is present, write a wake-request and return true.
 * Returns false (no-op) when the server is not asleep.
 */
export function writeWakeRequestIfSlept(stateDir: string, nowIso: string): boolean {
  try {
    const stateSub = path.join(stateDir, 'state');
    if (!fs.existsSync(path.join(stateSub, 'slept-marker.json'))) return false;
    fs.mkdirSync(stateSub, { recursive: true });
    fs.writeFileSync(
      path.join(stateSub, 'wake-requested.json'),
      JSON.stringify({ requestedBy: 'TelegramLifeline', requestedAt: nowIso }),
    );
    return true;
  } catch {
    return false; // @silent-fallback-ok — forward retry/queue still delivers the message
  }
}
