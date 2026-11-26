# Side effects of the disposable local history copy pilot

The Chief of Staff authorized a test agent with a fresh disposable home and generated synthetic history on November 24, 2026. The pilot exercises the existing ledger and exact store write plans in an isolated process. It has no native route or production copy switch.

## Scope

A named test deployment owns a fresh private state directory. The pilot uses the actual same-device volume and actual free-space readings. It reserves 64 MiB for run overhead, adds a checked physical estimate before each of the source claim, conversation and manifest mutations, and charges the claim's full forward and rollback database ceilings plus its journal. The existing 64 KiB ledger transaction allowance and the greater of 2 GiB and 5% of volume capacity are preserved. The pilot retains the aggregate charge until readback and settlement.

## Refusal

The live refusal probe requests an unwritten reservation that fits the raw available bytes and would cross the protected floor. It checks the reservation and payload directories for changes before doing the bounded copy. It writes no disk filler. A failed or missing reservation, changed volume, budget overflow, or failed floor recheck stops the experiment.

## Authority and remaining hold

An exact local plan and sufficient measured free space are prerequisites for the disposable pilot. No production eligibility, client authorization, worker permit, or rollback recovery is inferred from that evidence. The real-user copy hold remains until worst-case Studio shared-volume drawdown is measured over several real copies and the Chief of Staff clears that hold. The reserve policy assumes unrelated writers may change available space between measurements.

## Teardown

The disposable deployment harness stops the test server. After verified readback the pilot settles its reservation and removes the private synthetic state it created. The initial failed startup and subsequent attempt are retained as separate diagnostic receipts in the project state directory.

## Observed result

On the Studio, the live available space was 372,783,050,752 bytes. The ledger refused an unwritten request of 347,916,486,144 bytes, which would leave 24,866,564,608 bytes against a floor of 49,733,129,216 bytes. The refusal left the destination and allocation directory unchanged.

The bounded attempt held 71,098,368 bytes at the manifest step, read back all 64 synthetic messages and verified one attachment. It disposed its reservation after readback and removed the synthetic state. The deployment check and 44 focused tests passed. The harness and the copy process ran separately in the same disposable home. The first harness startup rejected a generated name with punctuation and uppercase characters. A fresh home with a valid name passed startup, health verification, and teardown. No measurements are claimed as worst-case shared-volume evidence.
