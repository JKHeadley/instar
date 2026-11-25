# Side effects of staging the disposable first permit

The existing staged-copy path can commit a single first-claim permit only in the canonical disposable synthetic pilot state. The worker independently admits only the built-in generated artifact. Staging rechecks the actual owner, sealed intent, preview index and exact destination inside the applying transition transaction. Issuance is fenced before commit and the registered worker receives the exact permit only after commit.

The coordinator marks the limited attempt interrupted after close, retains its permit and reservation, and records acknowledgement after validated completion. A failed or ambiguous transaction can conservatively hold a reservation until recovery. After successful commit, a lost acknowledgement leaves the operation interrupted with the reservation retained. There is no append, manifest write or implicit retry. Recovery continues to quarantine the retained slot.

Normal previews and discard observations keep their existing behavior. This staging entry point is exercised in a named disposable fixture and has no signed route yet. The pilot's actual server route must keep the input and budget internally controlled. Real-user copying remains held. Existing durable attempt records and reservations must remain recoverable if this staging method is reverted.

Independent rereview concurred. The disposable fixture verifies a completed claim, durable acknowledgement and interrupted status. A fresh staging generation preserves the exact charge. The fixture injects the disk reading. A parent exit after commit is covered by the existing separate quarantine fixture.
