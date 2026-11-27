/**
 * friendlyMachineName — the name a person already calls this machine.
 *
 * Operator report 2026-11-12: footers read "Machine m_4851af". A machine must always
 * carry a human name, assigned with no question asked. The best source is the name the
 * owner already gave the computer:
 *   - macOS: the Sharing name (`scutil --get ComputerName`, e.g. "Justin's MacBook Pro").
 *   - Linux: the pretty hostname (`hostnamectl --pretty`, else PRETTY_HOSTNAME in
 *     /etc/machine-info).
 *   - Either, as a last resort: the hostname, prettified ("dev-box-2.local" → "Dev Box 2").
 *
 * `friendlyNameFrom` is pure (unit-tested per platform); `detectFriendlyMachineName` does the
 * bounded, never-throwing reads. The result always passes `isValidNickname` or is null.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { isValidNickname } from './NicknameAssigner.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';

const MAX = 40;

/** One printable line in the nickname alphabet (letters, digits, spaces, hyphens, apostrophes), or null. */
export function sanitizeFriendlyName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'") // typographic apostrophes → '
    .replace(/[^\w '\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\w]+/, '')
    .slice(0, MAX)
    .trim();
  if (!cleaned || /^m_[0-9a-f]{6,}$/i.test(cleaned) || /^localhost$/i.test(cleaned)) return null;
  return isValidNickname(cleaned) ? cleaned : null;
}

/** "justins-mbp.local" → "Justins Mbp". Keeps words that already carry capitals. */
export function prettifyHostname(hostname: string | null | undefined): string | null {
  if (typeof hostname !== 'string') return null;
  const base = hostname.trim().replace(/\.local$/i, '').split('.')[0] ?? '';
  const words = base.split(/[-_\s]+/).filter(Boolean)
    .map((w) => (/[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
  return sanitizeFriendlyName(words.join(' '));
}

export interface FriendlyNameSources {
  platform: string;
  /** macOS `scutil --get ComputerName`. */
  computerName?: string | null;
  /** Linux `hostnamectl --pretty` or PRETTY_HOSTNAME. */
  prettyHostname?: string | null;
  hostname?: string | null;
}

/** Pick the friendliest available name for this platform. Pure. */
export function friendlyNameFrom(src: FriendlyNameSources): string | null {
  const p = (src.platform || '').toLowerCase();
  const first = p.startsWith('darwin') ? sanitizeFriendlyName(src.computerName)
    : p.startsWith('linux') ? sanitizeFriendlyName(src.prettyHostname)
      : null;
  return first ?? prettifyHostname(src.hostname);
}

function run(cmd: string, args: string[]): string | null {
  try {
    return withSyncOp(() => execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null;
  } catch { /* @silent-fallback-ok — tool absent or slow; the next source is tried */ return null; }
}

function machineInfoPrettyHostname(): string | null {
  try {
    const text = fs.readFileSync('/etc/machine-info', 'utf8');
    const m = /^PRETTY_HOSTNAME=(.*)$/m.exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { /* @silent-fallback-ok — no machine-info file on most hosts */ return null; }
}

/** The friendly name of the machine this process runs on, or null when nothing usable exists. Never throws. */
export function detectFriendlyMachineName(platform: string = process.platform): string | null {
  const p = platform.toLowerCase();
  let hostname: string | null = null;
  try { hostname = os.hostname(); } catch { /* @silent-fallback-ok — hostname unreadable */ }
  return friendlyNameFrom({
    platform: p,
    computerName: p.startsWith('darwin') ? run('scutil', ['--get', 'ComputerName']) : null,
    prettyHostname: p.startsWith('linux') ? (run('hostnamectl', ['--pretty']) ?? machineInfoPrettyHostname()) : null,
    hostname,
  });
}
