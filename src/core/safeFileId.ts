/**
 * SEC-127: ids that arrive from peers (message ids, thread ids) become file names.
 * An id is only usable as a file name when it is ONE plain path component, so
 * `../`, an absolute path or a NUL can never reach a file outside the folder the
 * caller joins it into. Every legitimate id (UUIDs, `msg-…`, `thr-…`, `thread-…`,
 * relay ids) passes.
 *
 * Length bound, in BYTES: file systems cap one file name at 255 bytes (APFS, ext4,
 * NTFS). The longest name built from an id is ThreadLog's rotation temp file
 * `<id>.log.jsonl.<pid>.rot.tmp`: `.log.jsonl.` (11) + a pid of at most 7 digits
 * (Linux pid_max 4194304) + `.rot.tmp` (8) = 26 bytes of suffix, so the id may
 * use 255 - 26 = 229. (MessageStore's `<id>.json.tmp.<pid>` and ThreadLog's
 * `<id>.meta.json.<pid>.tmp` are shorter.) Wire ids are capped far lower
 * (MESSAGE_ID_MAX = 128 in InboundIdLedger), so no real id is refused.
 */
export const MAX_FILE_ID_BYTES = 255 - '.log.jsonl.'.length - 7 - '.rot.tmp'.length;

export function isSafeFileId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length > 0
    && Buffer.byteLength(id, 'utf8') <= MAX_FILE_ID_BYTES
    && id !== '.'
    && id !== '..'
    && !/[/\\\0]/.test(id);
}
