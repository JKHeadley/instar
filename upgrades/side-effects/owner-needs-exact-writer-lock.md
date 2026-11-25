# Exclusive local lifetime for the dark decision writer

An explicitly configured decision writer holds the existing kernel-backed lock while its journal is active. The writer must hold both the kernel lease and its advisory inode before it appends or reconciles an exact decision. Advisory-only journals cannot enter those paths. Updated advisory contenders do not reclaim a live strict owner on mtime alone. A closing instance checks the inode before unlinking. Strict writers stop flushing if the kernel lease becomes unavailable.

The synchronous kernel helper remains responsive to exit events while held. Ownership-record write failures now release the helper during acquisition and release. The normal journal startup keeps its existing advisory posture. Older local binaries do not interpret the strict ownership marker. Production remains unwired until local writers are on the supported posture and the exact reconciliation adapter is verified. Rollback reverts the code and requires no data migration on an unused dark writer.

## Second-pass review

**Reviewer:** Independent journal safety reviewer.
**Result:** Concur for the unwired checkpoint. The review identified a worker that could miss helper exit and a cleanup path that could leave the kernel lock held. Both paths were corrected. The real contender fixture covers clean release. Independent helper death, process crash and mixed-version ownership require activation evidence.

## Class-Closure Declaration

The unbounded-self-action class is inapplicable. Strict journal startup attempts kernel acquisition once on explicit open and does not schedule a retry. Helper release is one-shot cleanup.
