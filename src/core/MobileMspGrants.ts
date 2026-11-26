/**
 * Owner grants for MSP phones (docs/specs/mobile-app-people-and-roles.md §3.5). By default an MSP
 * phone may not use the owner's own app conversations or Slack. The OWNER — and only through an
 * owner phone's device signature — may open either for one MSP person. Off by default; a person
 * with no row has no grant.
 *
 * Persistence: `state/mobile-msp-grants.json` (atomic write, 0600), keyed by the person's
 * `UserProfile.id`. Machine-local, beside the device registry whose phones it applies to.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface MspGrant {
  /** May use the owner's own app conversations (list, read, send, rename, delete, their files). */
  ownerConversations: boolean;
  /** May use Slack from the app. */
  slack: boolean;
  setAt: string;
  /** The owner phone that set it (audit). */
  setByDevice: string;
}

export const NO_GRANT: Readonly<Pick<MspGrant, 'ownerConversations' | 'slack'>> = Object.freeze({ ownerConversations: false, slack: false });

interface GrantsFile { grants: Record<string, MspGrant> }

export class MspGrantStore {
  readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'mobile-msp-grants.json');
  }

  private read(): GrantsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<GrantsFile>;
      const out: Record<string, MspGrant> = {};
      if (raw && raw.grants && typeof raw.grants === 'object') {
        for (const [id, g] of Object.entries(raw.grants)) {
          if (!g || typeof g !== 'object') continue;
          out[id] = {
            ownerConversations: g.ownerConversations === true, slack: g.slack === true,
            setAt: typeof g.setAt === 'string' ? g.setAt : '', setByDevice: typeof g.setByDevice === 'string' ? g.setByDevice : '',
          };
        }
      }
      return { grants: out };
    } catch {
      // @silent-fallback-ok — a missing or unreadable file grants nothing (fail closed: the MSP keeps the default limits)
      return { grants: {} };
    }
  }

  /** The grant for one person; no row ⇒ nothing granted. */
  get(userId: string): Pick<MspGrant, 'ownerConversations' | 'slack'> {
    const g = this.read().grants[userId];
    return g ? { ownerConversations: g.ownerConversations, slack: g.slack } : NO_GRANT;
  }

  all(): Record<string, MspGrant> { return this.read().grants; }

  /** Set one or both permissions for a person (fields left undefined keep their value). */
  set(userId: string, change: { ownerConversations?: boolean; slack?: boolean }, byDevice: string): MspGrant {
    const f = this.read();
    const cur = f.grants[userId] ?? { ownerConversations: false, slack: false, setAt: '', setByDevice: '' };
    const next: MspGrant = {
      ownerConversations: change.ownerConversations ?? cur.ownerConversations,
      slack: change.slack ?? cur.slack,
      setAt: new Date(this.now()).toISOString(), setByDevice: byDevice,
    };
    if (!next.ownerConversations && !next.slack) delete f.grants[userId];
    else f.grants[userId] = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return next;
  }
}
