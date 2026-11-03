/**
 * The checks on a file an agent attaches to an app reply (docs/specs/mobile-native-chat-media.md
 * §4.6, steps 1-5). In order: confine the path, open it once and check the descriptor, limit and
 * reserve before copying, snapshot, and run the existing live-credential wall over the snapshot.
 *
 * What this protects against: an agent attaching a credential file by mistake or because a
 * message talked it into naming one. It does not stop a session that deliberately packs a key
 * into an archive or an encrypted file; those contents cannot be inspected (§4.6).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppMediaStore, Refusal } from './AppMediaStore.js';
import { scanPrintableRuns, snapshotDescriptor, type HashedFile } from './appMediaWorker.js';
import { CONTROL_CHARS, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_MESSAGE_BYTES } from './appMediaTypes.js';

/** A home-level credential location, matched by path component inside the admitting root. */
export function isCredentialPath(relative: string): boolean {
  const parts = relative.split(path.sep).filter(Boolean).map((p) => p.toLowerCase());
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i]!;
    const next = parts[i + 1];
    if (['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.netrc', '.npmrc', '.pypirc', '.instar'].includes(c)) return true;
    if (c.startsWith('.claude') || c.startsWith('.codex')) return true;
    if (c === '.docker' && next === 'config.json') return true;
    if (c === '.config' && (next === 'gh' || next === 'gcloud')) return true;
    if (c === 'library' && next === 'keychains') return true;
  }
  return false;
}

function realOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; } // @silent-fallback-ok — a root that does not exist admits nothing
}

const inside = (root: string, file: string): boolean => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Step 1: the checked real path, or the refusal. */
export function confineReplyPath(requested: string, roots: { projectDir: string; outboxDir: string }, neverServed: (projectRelative: string) => boolean): { real: string } | Refusal {
  const notAllowed: Refusal = { status: 403, error: 'path-not-allowed', detail: 'Only files in the project, the agent outbox or the temporary directory can be sent.' };
  const keyMaterial: Refusal = { status: 403, error: 'key-material', detail: 'This path holds credentials and cannot be sent.' };
  if (!path.isAbsolute(requested)) return notAllowed;
  let real: string;
  try { real = fs.realpathSync(requested); } catch { return { status: 404, error: 'file-not-found', detail: 'That file does not exist.' }; }
  const outbox = realOrNull(roots.outboxDir);
  if (outbox && inside(outbox, real)) return { real };
  const project = realOrNull(roots.projectDir);
  const temps = [os.tmpdir(), '/tmp'].map(realOrNull).filter((p): p is string => !!p);
  const root = project && inside(project, real) ? project : temps.find((t) => inside(t, real));
  if (!root) return notAllowed;
  if (isCredentialPath(path.relative(root, real))) return keyMaterial;
  if (project && inside(project, real) && neverServed(path.relative(project, real))) return keyMaterial;
  return { real };
}

export interface ReplySnapshot { requested: string; snapshotPath: string; hashed: HashedFile; filename: string }

export interface PreparedReplyFiles { snapshots: ReplySnapshot[]; reservationIds: string[] }

/**
 * Steps 1-4 for the whole reply, plus the scan of step 5 through `detect` (the same detector as
 * reply text). On any refusal every snapshot and reservation of this reply is released.
 */
export async function prepareReplyFiles(
  media: AppMediaStore,
  files: ReadonlyArray<string>,
  roots: { projectDir: string; outboxDir: string },
  neverServed: (projectRelative: string) => boolean,
  detect: (text: string) => { detected: boolean; kind?: string },
): Promise<PreparedReplyFiles | Refusal> {
  const admitted = await admitFileSnapshots(media, files, (requested) => confineReplyPath(requested, roots, neverServed));
  if ('status' in admitted) return admitted;
  const prepared = admitted;
  const abandon = (r: Refusal): Refusal => {
    discardPrepared(media, prepared);
    return r;
  };
  // The names reach the phone too: a credential in a file name is refused like one in the text.
  const named = detect(prepared.snapshots.map((s) => s.filename).join('\n'));
  if (named.detected) return abandon({ status: 422, error: 'credential-exposure-guard', detail: `A file name holds a live credential (${named.kind ?? 'credential'}) and was not sent. Rename the file and send it again.` });
  // Step 5: the live-credential wall over every snapshot.
  for (const s of prepared.snapshots) {
    let hit: string | null = null;
    await scanPrintableRuns(s.snapshotPath, { minRun: 16, batchChars: 512 * 1024, overlap: 1024 }, (batch) => {
      if (hit) return;
      const d = detect(batch);
      if (d.detected) hit = d.kind ?? 'credential';
    });
    if (hit) {
      return abandon({ status: 422, error: 'credential-exposure-guard', detail: `${path.basename(s.requested)} holds a live credential (${hit}) and was not sent. Remove it and send the file again.` });
    }
  }
  return prepared;
}

/**
 * Steps 2-4 of §4.6, shared by every path that admits a local file into the blob store (an agent
 * reply, a Telegram or Slack inbound copy, §4.7): resolve the path (the caller's confinement), one
 * open with no symlink and the descriptor checked against what was resolved, the size limits, a
 * reservation (disk floor and store cap) before any byte is copied, then a hashed snapshot. On any
 * refusal every snapshot and reservation made so far is released. No content scan here.
 */
export async function admitFileSnapshots(
  media: AppMediaStore,
  files: ReadonlyArray<string>,
  resolve: (requested: string) => { real: string } | Refusal,
): Promise<PreparedReplyFiles | Refusal> {
  if (files.length < 1 || files.length > MAX_ATTACHMENTS) return { status: 413, error: 'too-many-files', detail: `A reply can carry at most ${MAX_ATTACHMENTS} files.` };
  const prepared: PreparedReplyFiles = { snapshots: [], reservationIds: [] };
  const handles: Array<{ fd: number; requested: string; size: number }> = [];
  const closeAll = () => { for (const h of handles.splice(0)) { try { fs.closeSync(h.fd); } catch { /* @silent-fallback-ok — already closed */ } } };
  const abandon = (r: Refusal): Refusal => {
    closeAll();
    discardPrepared(media, prepared);
    return r;
  };
  let total = 0;
  for (const requested of files) {
    const c = resolve(requested);
    if ('status' in c) return abandon(c);
    // Step 2: one open, no symlink, and the descriptor must be the file that was checked.
    let st: fs.Stats;
    try { st = fs.statSync(c.real); } catch { return abandon({ status: 404, error: 'file-not-found', detail: 'That file does not exist.' }); }
    let fd: number;
    try { fd = fs.openSync(c.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return abandon({ status: 403, error: 'path-not-allowed', detail: 'That file could not be opened safely.' }); }
    handles.push({ fd, requested, size: 0 });
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) return abandon({ status: 403, error: 'path-not-allowed', detail: 'That file changed while it was being checked.' });
    if (opened.nlink > 1) return abandon({ status: 403, error: 'hard-link', detail: 'A hard-linked file cannot be sent.' });
    if (opened.size < 1) return abandon({ status: 400, error: 'empty-file', detail: 'That file is empty.' });
    // Step 3: limits and the reservation before any byte is copied.
    if (opened.size > MAX_FILE_BYTES) return abandon({ status: 413, error: 'file-too-large', detail: 'A file can be at most 50 MiB.' });
    total += opened.size;
    if (total > MAX_MESSAGE_BYTES) return abandon({ status: 413, error: 'reply-too-large', detail: 'A reply can carry at most 64 MiB.' });
    handles[handles.length - 1]!.size = opened.size;
  }
  for (const h of handles) {
    const id = crypto.randomUUID();
    const refused = media.reserveReplyBytes(id, h.size);
    if (refused) return abandon(refused);
    prepared.reservationIds.push(id);
  }
  // Step 4: the snapshot. Every later step reads it, so a change to the source cannot slip past.
  for (const h of handles) {
    const snapshotPath = media.newSnapshotPath();
    const copied = await snapshotDescriptor(h.fd, snapshotPath, h.size);
    if ('over' in copied) {
      media.discardSnapshot(snapshotPath);
      return abandon({ status: 413, error: 'file-grew', detail: 'That file grew while it was being copied.' });
    }
    const name = path.basename(h.requested).replace(new RegExp(CONTROL_CHARS.source, 'g'), '_').slice(-255) || 'file';
    prepared.snapshots.push({ requested: h.requested, snapshotPath, hashed: copied, filename: name });
  }
  closeAll();
  return prepared;
}

export function discardPrepared(media: AppMediaStore, prepared: PreparedReplyFiles): void {
  for (const s of prepared.snapshots) media.discardSnapshot(s.snapshotPath);
  for (const id of prepared.reservationIds) media.releaseReply(id);
}
