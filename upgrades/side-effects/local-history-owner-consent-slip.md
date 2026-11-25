# Side effects of the dormant owner history consent proof

The new helper uses the Work Board canonical hash and the existing native owner-presence envelope and challenge store. The action line binds a specific card revision, disclosure, sealed preview, ordered source artifacts, destination and owner, boot, expiry and apply request. It verifies the current phone's enrolled presence key and consumes that exact short-lived challenge once.

This helper has no registered permission action, route, card creator, UI or call to staging. Its proof gives no copy authority. The future endpoint must resolve the real source owner and native owner phone, build material from the current sealed preview and card, and consume durable copy authority together with the first permit. Existing Work Board approvals and real-history hold remain in effect.

The unit test uses actual P-256 signatures. It covers change to the card, disclosure, source order, destination or boot, other owner and host, revoked phone, expired challenge and replay. Reverting this helper changes no persisted state.

The internal challenge binding also includes the enrolled presence key's fingerprint. A changed key requires a new challenge even when the device identifier and slip material match. The signed presence envelope remains compatible with the Work Board app format.

Independent rereview concurred. The P-256 fixture rejects both an old-key signature after rotation and a valid replacement-key signature over the old challenge.
