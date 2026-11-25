# Direct Threadline request binding

The dormant codec hashes the exact well-formed UTF-8 message to the verified owner evidence reference, serving epoch, sender, paired recipient, resolved thread, reply target and delivery ID. The dormant first slice accepts text only.

- Authority. No caller, permission or send is added. The runtime must independently prove owner origin and both current identities before comparing the binding.
- Over-block. Missing resolved routing, malformed text and attachments fail the fixture.
- Under-block. A digest proves no authority or consumption. Runtime admission must use this same binding and record the exact effect.
- Multi-machine posture. The binding includes serving epoch and immutable identities. The codec makes no state.
- Rollback. Reverting the codec requires no stored changes.

Independent review concurred for the dormant codec after matching the real text-only contract and guarding ambiguous Unicode.
