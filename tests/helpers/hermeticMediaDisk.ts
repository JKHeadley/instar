/**
 * Hermetic disk reading for a test agent's App media store.
 *
 * The media store refuses uploads with 507 media-disk-floor when the HOST volume has less than
 * max(5% of total, 2 GiB) free (src/core/AppMediaStore.ts, mediaDiskFloorBytes). A test agent
 * shares the host's volume, so without this a media test passed or failed with the machine it ran
 * on (2026-11-27: four media e2e files failed on an M5 with 41 GiB free under a 46.3 GiB floor).
 *
 * This gives the store a fixed reading with ample space, as an own property, so a later
 * `vi.restoreAllMocks()` cannot put the host reading back and a test that spies on `diskSpace` to
 * simulate a full disk returns to this reading when its spy is restored. The production floor is
 * unchanged; tests that prove the 507 refusal keep doing it by mocking a full disk.
 */
export const AMPLE_MEDIA_DISK = Object.freeze({ free: 1e12, total: 2e12 });

export function useHermeticMediaDisk(server: { appConversations?: { media?: unknown } | null }): void {
  const media = server.appConversations?.media as { diskSpace?: () => { free: number; total: number } | null } | null | undefined;
  // Throw rather than skip: a silent no-op would put the test back on the host's disk unnoticed.
  if (!media) throw new Error('useHermeticMediaDisk: the server has no App media store to make hermetic');
  Object.defineProperty(media, 'diskSpace', { value: () => ({ ...AMPLE_MEDIA_DISK }), configurable: true, writable: true });
}
