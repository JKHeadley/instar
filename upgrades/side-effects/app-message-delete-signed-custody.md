# Signed creation proof and durable custody admission

This unmounted checkpoint adds bounded, versioned creation proof bytes and
checks first admission against current key eligibility. The custody store can
atomically retain the proof and admission with the immutable assignment.
Reopening rechecks the signature with an injected historical authority.
Malformed storage and conflicting assignments are refused.

No routing, live transport, or production authority is enabled. The focused
tests exercise signatures and immutable storage. A fresh-process fixture
exercises reopening and denial under simulated rolled-back authority.

## 6b. Operator-surface quality

This checkpoint adds no user-facing behavior.

## Framework generality

The proof binds the deployment, conversation, creation record, and machine
identity independently of the client platform.

Signed peer admissions use a separate directory from local custody evidence.
The signed store requires admission evidence and the local store refuses it.
Existing unsigned records keep their original location and behavior. This
separation does not authorize either store to serve a fleet request.
