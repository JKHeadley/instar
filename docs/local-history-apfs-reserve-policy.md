# Local history copy reserve on Mac

November 24, 2026. This policy is an evidence checkpoint for the existing-store copy lane. Copy execution remains held.

## Proposed admission policy

Use the existing ledger floor for both measured Apple silicon Mac models. Keep the greater of 2 GiB and 5% of the destination volume's total bytes free after outstanding commitments and the proposed reservation. Sample available bytes from the pinned same-device volume. Refuse if the volume changes, a measurement or mutation bound is unavailable, or the proposed reservation would breach the floor.

Before a first claim, charge the ledger's existing 64 KiB transaction allowance, all outstanding unwritten allocations, a 64 MiB run allowance for setup and filesystem overhead, and the exact first claim estimate. The estimate rounds to the measured allocation block and includes two full database-ceiling writes, one for the forward path and one for rollback, plus the journal ceiling and 1 MiB of metadata allowance. Hold the charge through verified child exit and settlement. A later mutation would need its own checked estimate before a permit. Include the independently rounded append, every attachment, and the complete replacement manifest as applicable, with 1 MiB per operation plus 64 KiB per attachment for metadata. Never reuse a rollback allowance for a different outstanding mutation.

The tested policy envelope uses one serial writer, a 256 MiB aggregate run reservation ceiling and at most 32 attachments per planned conversation. Refuse operations above that envelope until covered by a separate decision. The proposed allowances are conservative policy choices. Their validation below covers a bounded synthetic workload and the admission arithmetic.

## Measurement and refusal evidence

| Machine | Actual volume | Available at probe start | Remaining floor | Largest sampled volume drawdown |
| --- | --- | ---: | ---: | ---: |
| Studio, Mac16,9, macOS 26.7.3 | APFS SSD, 4,096-byte blocks | 345.203 GiB | 46.318 GiB | 13.17 MiB |
| Laptop, Mac16,5, macOS 15.6.1 | APFS SSD, 4,096-byte blocks | 113.143 GiB | 46.318 GiB | 4.15 MiB |

The measured total was 994,662,584,320 bytes per machine and the floor was 49,733,129,216 bytes. Three disposable runs per machine used the agent root's actual data volume. Each included a synced 1 MiB append, 32 attachments, a 256 KiB manifest replacement, an APFS clone overwrite and a SQLite rollback. The probe verified changed SQLite data reached the database file before rollback and checked that rollback restored every row. It also verified clone overwrite preserved the source. The fixture's calculated charge across these phases was about 76.4 MiB, including the run allowance. The SQLite versions used by the volume probe were 3.51.0 on Studio and 3.43.2 on Laptop.

The production ledger was exercised in a disposable Studio fixture with each measured volume geometry and injected near-floor free readings. With 2 MiB already outstanding, it refused the 74,485,760-byte initial reservation at 49,809,777,663 bytes free and admitted it at 49,809,777,664 bytes. A further one-byte growth was refused at that same reading and preserved the existing charge. The growth succeeded after one additional byte of capacity. Twenty-eight existing ledger and estimator tests also passed.

These real-volume samples are phase observations. Studio shared volume activity shifted free space by as much as 13.17 MiB even during a short idle control. The probe can miss peaks between observations and does not establish a worst-case APFS allocation bound. The 64 MiB allowance and the fixture-size cap must be considered in that light. Production copy integration, enforcement of the later-mutation estimates, and full verification remain pending.

Reproduction scripts and raw receipts are in the project state directory under reserve-policy-20261124.
