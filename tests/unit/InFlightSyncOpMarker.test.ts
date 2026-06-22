// Unit tests for InFlightSyncOpMarker — the single chokepoint recording whether ANY
// synchronous subprocess/blocking op is in flight on the event loop RIGHT NOW.
//
// The module holds process-wide mutable state (intentional, like cpuStarvation), so every
// test isolates via __resetSyncOpMarker(). TTL cases inject a deterministic clock via
// __setSyncOpClock; the cross-process round-trip uses a real mktemp dir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  withSyncOp,
  readSyncOpMarker,
  configureSyncOpMarker,
  defaultInflightMarkerReader,
  __setSyncOpClock,
  __resetSyncOpMarker,
  DEFAULT_SYNC_OP_TIMEOUT_MS,
  STALE_TTL_FACTOR,
  MARKER_FILENAME,
} from '../../src/core/InFlightSyncOpMarker.js';

const DEFAULT_TTL = DEFAULT_SYNC_OP_TIMEOUT_MS * STALE_TTL_FACTOR; // 18_000

describe('InFlightSyncOpMarker', () => {
  beforeEach(() => {
    __resetSyncOpMarker();
  });
  afterEach(() => {
    __resetSyncOpMarker();
  });

  describe('withSyncOp enter/leave depth', () => {
    it('is not in-flight before any op, in-flight during, and clears after', () => {
      expect(readSyncOpMarker().inFlight).toBe(false);
      expect(readSyncOpMarker().depth).toBe(0);

      let duringDepth = -1;
      let duringInFlight: boolean | null = null;
      const ret = withSyncOp(() => {
        const m = readSyncOpMarker();
        duringDepth = m.depth;
        duringInFlight = m.inFlight;
        return 'value';
      });

      expect(ret).toBe('value'); // returns the callback's value
      expect(duringInFlight).toBe(true);
      expect(duringDepth).toBe(1);

      const after = readSyncOpMarker();
      expect(after.inFlight).toBe(false);
      expect(after.depth).toBe(0);
      expect(after.ageMs).toBeNull();
    });
  });

  describe('overlapping ops use a COUNTER (depth)', () => {
    it('depth goes to 2 when nested, and only returns to 0 after BOTH leave', () => {
      let innerDepth = -1;
      let outerStillInFlightAfterInner: boolean | null = null;

      withSyncOp(() => {
        expect(readSyncOpMarker().depth).toBe(1);
        withSyncOp(() => {
          innerDepth = readSyncOpMarker().depth;
        });
        // inner has left, but outer is still open: depth back to 1, still in-flight
        const m = readSyncOpMarker();
        outerStillInFlightAfterInner = m.inFlight;
        expect(m.depth).toBe(1);
      });

      expect(innerDepth).toBe(2); // overlapped => counter reached 2
      expect(outerStillInFlightAfterInner).toBe(true);
      // both have left now
      expect(readSyncOpMarker().depth).toBe(0);
      expect(readSyncOpMarker().inFlight).toBe(false);
    });
  });

  describe('throwing callback', () => {
    it('still clears the marker via try/finally AND rethrows the error', () => {
      const boom = new Error('callback exploded');
      expect(() =>
        withSyncOp(() => {
          expect(readSyncOpMarker().depth).toBe(1); // marker was set
          throw boom;
        }),
      ).toThrow(boom);

      // finally ran => depth cleared back to 0 despite the throw
      const after = readSyncOpMarker();
      expect(after.inFlight).toBe(false);
      expect(after.depth).toBe(0);
    });

    it('a throw in an INNER op still decrements depth back to the outer level', () => {
      withSyncOp(() => {
        expect(() =>
          withSyncOp(() => {
            throw new Error('inner');
          }),
        ).toThrow('inner');
        // inner's finally decremented; outer still open at depth 1
        expect(readSyncOpMarker().depth).toBe(1);
      });
      expect(readSyncOpMarker().depth).toBe(0);
    });
  });

  describe('setAtMs stamps the EARLIEST op', () => {
    it('does not advance the stamp when a 2nd op enters while the 1st is open', () => {
      let clock = 1_000_000;
      __setSyncOpClock(() => clock);

      withSyncOp(() => {
        // first op stamped at 1_000_000 => age 0
        expect(readSyncOpMarker().ageMs).toBe(0);
        clock = 1_005_000; // 5s later
        withSyncOp(() => {
          // 2nd enter must NOT re-stamp; age is measured from the EARLIEST op (5s)
          const m = readSyncOpMarker();
          expect(m.depth).toBe(2);
          expect(m.ageMs).toBe(5_000);
        });
        // back to depth 1, stamp unchanged => still measured from 1_000_000
        clock = 1_006_000;
        expect(readSyncOpMarker().ageMs).toBe(6_000);
      });
    });
  });

  describe('TTL self-heal in readSyncOpMarker', () => {
    it('a marker older than 2x timeout reads inFlight:false, stale:true, and bumps staleMarkerCount', () => {
      let clock = 2_000_000;
      __setSyncOpClock(() => clock);

      // Open an op but never leave it (simulate a leaked marker / a process the leave never reached).
      // Use enter via withSyncOp but read while still "inside" by stamping then advancing the clock.
      // We open the op, advance the clock past the TTL, and read while depth>0.
      // To keep depth>0 across the read, hand-build the in-flight state by entering without leaving:
      const before = readSyncOpMarker().staleMarkerCount;
      // enter an op and read DURING it after advancing the clock past TTL
      let observed: ReturnType<typeof readSyncOpMarker> | null = null;
      withSyncOp(() => {
        clock = 2_000_000 + DEFAULT_TTL + 1; // just past 2x timeout
        observed = readSyncOpMarker();
      });

      expect(observed).not.toBeNull();
      expect(observed!.inFlight).toBe(false); // self-healed
      expect(observed!.stale).toBe(true);
      expect(observed!.ageMs).toBeNull();
      expect(observed!.depth).toBe(0);
      expect(observed!.staleMarkerCount).toBe(before + 1);
    });

    it('a marker within the TTL is NOT stale and reads inFlight:true', () => {
      let clock = 3_000_000;
      __setSyncOpClock(() => clock);
      withSyncOp(() => {
        clock = 3_000_000 + DEFAULT_TTL - 1; // one ms under the TTL
        const m = readSyncOpMarker();
        expect(m.inFlight).toBe(true);
        expect(m.stale).toBe(false);
        expect(m.ageMs).toBe(DEFAULT_TTL - 1);
      });
    });
  });

  describe('TTL self-heal in enter()', () => {
    it('resets a leaked depth before incrementing for the next op', () => {
      let clock = 5_000_000;
      __setSyncOpClock(() => clock);

      // Leak an op: enter it, but advance the clock past the TTL while NOT leaving the outer.
      // Then a NEW op entering should reset the stale depth (count 1) and stamp fresh.
      const baseStale = readSyncOpMarker().staleMarkerCount;
      withSyncOp(() => {
        clock = 5_000_000 + DEFAULT_TTL + 1; // outer op is now stale
        // A nested enter() sees the stale outer (depth>0, aged past TTL) and resets it
        // before incrementing. So depth should be 1 (not 2) and the stamp should be fresh.
        withSyncOp(() => {
          const m = readSyncOpMarker();
          expect(m.depth).toBe(1); // stale outer was reset, this is a fresh count of 1
          expect(m.ageMs).toBe(0); // freshly stamped at the current clock
          expect(m.staleMarkerCount).toBe(baseStale + 1); // enter() counted the heal
        });
      });
    });
  });

  describe('configureSyncOpMarker({callTimeoutMs}) changes the TTL', () => {
    it('a shorter timeout makes a marker stale sooner', () => {
      configureSyncOpMarker({ callTimeoutMs: 1000 }); // TTL becomes 2000ms
      let clock = 7_000_000;
      __setSyncOpClock(() => clock);

      withSyncOp(() => {
        clock = 7_000_000 + 1999; // under the new 2000ms TTL
        expect(readSyncOpMarker().stale).toBe(false);
        expect(readSyncOpMarker().inFlight).toBe(true);
      });

      // reopen and push just past the new TTL
      let clock2 = 8_000_000;
      __setSyncOpClock(() => clock2);
      withSyncOp(() => {
        clock2 = 8_000_000 + 2001; // past 2x1000
        const m = readSyncOpMarker();
        expect(m.stale).toBe(true);
        expect(m.inFlight).toBe(false);
      });
    });

    it('ignores a non-positive / non-finite callTimeoutMs (keeps the prior TTL)', () => {
      configureSyncOpMarker({ callTimeoutMs: 0 });
      configureSyncOpMarker({ callTimeoutMs: -5 });
      configureSyncOpMarker({ callTimeoutMs: NaN });
      let clock = 9_000_000;
      __setSyncOpClock(() => clock);
      withSyncOp(() => {
        clock = 9_000_000 + DEFAULT_TTL - 1; // still the default 18s TTL
        expect(readSyncOpMarker().stale).toBe(false);
      });
    });
  });

  describe('staleMarkerCount is monotonic', () => {
    it('never decreases across multiple heals', () => {
      let clock = 10_000_000;
      __setSyncOpClock(() => clock);

      const counts: number[] = [readSyncOpMarker().staleMarkerCount];
      for (let i = 0; i < 3; i++) {
        const base = 10_000_000 + i * 1_000_000;
        clock = base;
        withSyncOp(() => {
          clock = base + DEFAULT_TTL + 1; // force a heal each time
          counts.push(readSyncOpMarker().staleMarkerCount);
        });
      }
      // each entry >= the previous one
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
      }
      // and it actually grew (3 heals)
      expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(counts[0] + 3);
    });
  });

  describe('__resetSyncOpMarker', () => {
    it('restores defaults (depth, stamp, staleCount, clock, TTL) AND clears the mirror stateDir', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncop-reset-'));
      try {
        // dirty the state: a custom clock, a short TTL, a mirror dir, and a heal.
        configureSyncOpMarker({ callTimeoutMs: 100, stateDir: dir });
        let clock = 11_000_000;
        __setSyncOpClock(() => clock);
        withSyncOp(() => {
          clock = 11_000_000 + 100 * STALE_TTL_FACTOR + 1;
          readSyncOpMarker(); // forces a heal => staleMarkerCount > 0
        });
        expect(readSyncOpMarker().staleMarkerCount).toBeGreaterThan(0);

        __resetSyncOpMarker();

        // staleMarkerCount reset to 0
        const m = readSyncOpMarker();
        expect(m.staleMarkerCount).toBe(0);
        expect(m.depth).toBe(0);
        expect(m.inFlight).toBe(false);

        // clock restored to real Date.now (no fake clock pinning ageMs)
        // TTL restored to default: an op within DEFAULT_TTL is not stale even though
        // we had configured a 100ms TTL before the reset.
        // (Use a fresh fake clock to verify the TTL specifically.)
        let c2 = 12_000_000;
        __setSyncOpClock(() => c2);
        withSyncOp(() => {
          c2 = 12_000_000 + DEFAULT_TTL - 1;
          expect(readSyncOpMarker().stale).toBe(false); // default TTL is back
        });

        // mirror stateDir cleared: after reset (which nulls mirrorStateDir), a NEW op
        // must NOT write to the old dir. Remove any existing file, run an op, assert none.
        const markerFile = path.join(dir, 'state', MARKER_FILENAME);
        if (fs.existsSync(markerFile)) fs.rmSync(markerFile);
        __resetSyncOpMarker(); // ensure mirror dir is null again after the verify op above
        withSyncOp(() => {});
        expect(fs.existsSync(markerFile)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('cross-process round-trip (writer.serialize -> reader.parse)', () => {
    it('defaultInflightMarkerReader parses inFlight:true DURING the op and inFlight:false AFTER', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncop-rt-'));
      try {
        configureSyncOpMarker({ stateDir: dir });
        const reader = defaultInflightMarkerReader(dir);

        // before any op: no file yet => reader returns null (fail-open)
        expect(reader()).toBeNull();

        let duringRead: ReturnType<typeof reader> = null;
        withSyncOp(() => {
          duringRead = reader(); // a cross-process read DURING the in-flight op
        });

        // DURING: the mirror file was written with depth>0, setAtMs set, not stale
        expect(duringRead).not.toBeNull();
        expect(duringRead!.inFlight).toBe(true);
        expect(duringRead!.stale).toBe(false);

        // AFTER: leave() mirrored depth=0/setAtMs=null => reader sees not-in-flight
        const afterRead = reader();
        expect(afterRead).not.toBeNull();
        expect(afterRead!.inFlight).toBe(false);
        expect(afterRead!.stale).toBe(false);

        // the mirror file genuinely exists and round-trips through JSON.parse
        const markerFile = path.join(dir, 'state', MARKER_FILENAME);
        expect(fs.existsSync(markerFile)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(markerFile, 'utf-8'));
        expect(parsed).toHaveProperty('depth');
        expect(parsed).toHaveProperty('setAtMs');
        expect(parsed).toHaveProperty('timeoutMs');
        expect(parsed.depth).toBe(0); // after the op
        expect(parsed.setAtMs).toBeNull();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the cross-process reader reports stale (and inFlight:false) for an aged mirror file', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncop-rt-stale-'));
      try {
        // Hand-write a mirror file with an old setAtMs so the reader's Date.now-based age
        // exceeds 2x timeoutMs => stale, NOT in-flight (the cross-process self-heal).
        const stateSub = path.join(dir, 'state');
        fs.mkdirSync(stateSub, { recursive: true });
        const old = Date.now() - (STALE_TTL_FACTOR * DEFAULT_SYNC_OP_TIMEOUT_MS + 5000);
        fs.writeFileSync(
          path.join(stateSub, MARKER_FILENAME),
          JSON.stringify({ depth: 1, setAtMs: old, timeoutMs: DEFAULT_SYNC_OP_TIMEOUT_MS }),
        );
        const reader = defaultInflightMarkerReader(dir);
        const r = reader();
        expect(r).not.toBeNull();
        expect(r!.stale).toBe(true);
        expect(r!.inFlight).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reader returns null for a null stateDir and for an unparseable file (fail-open)', () => {
      expect(defaultInflightMarkerReader(null)()).toBeNull();

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncop-rt-bad-'));
      try {
        const stateSub = path.join(dir, 'state');
        fs.mkdirSync(stateSub, { recursive: true });
        fs.writeFileSync(path.join(stateSub, MARKER_FILENAME), 'not json {{{');
        expect(defaultInflightMarkerReader(dir)()).toBeNull();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('mirror is best-effort (never throws out of withSyncOp)', () => {
    it('an unwritable stateDir (a path UNDER a regular file) never throws', () => {
      const fileAsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncop-unwritable-'));
      const blockingFile = path.join(fileAsDir, 'iam-a-file');
      try {
        fs.writeFileSync(blockingFile, 'x'); // a regular file...
        // ...used as a stateDir, so path.join(blockingFile, 'state') can't be mkdir'd
        configureSyncOpMarker({ stateDir: blockingFile });

        let ran = false;
        let ret: string | undefined;
        expect(() => {
          ret = withSyncOp(() => {
            ran = true;
            // the in-memory marker still works even though the mirror write fails
            expect(readSyncOpMarker().inFlight).toBe(true);
            return 'ok';
          });
        }).not.toThrow();
        expect(ran).toBe(true);
        expect(ret).toBe('ok');

        // and the in-memory marker cleared correctly despite the failing mirror
        expect(readSyncOpMarker().inFlight).toBe(false);
      } finally {
        fs.rmSync(fileAsDir, { recursive: true, force: true });
      }
    });
  });
});
