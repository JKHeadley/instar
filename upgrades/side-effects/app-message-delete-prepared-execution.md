# Prepared history checks for private signed App Delete

A fresh Delete request checks signed scope and row access, prepares its history proof in the background, and then revalidates the same actor, exact target binding, serving custody, request status and prepared proof. A changed or unready proof leaves the request unreserved. Receipt recovery needs exact positive journal evidence and does not scan for absence.

The executor remains private to the signed fixture. Production mounting requires authoritative history and sync and validation of the server's process lock at the write boundary. The fixture serializes competing requests in one process. The shared-state two-process proof belongs to production mounting. This checkpoint adds no advertised action or provider write.

## 6b. Operator-surface quality

A long history can be checked before a removal without blocking the request handler on a full journal scan. A concurrent write or lost access cannot turn an old check into a new removal.

## Framework generality

The server contract is independent of the device client and agent harness.
