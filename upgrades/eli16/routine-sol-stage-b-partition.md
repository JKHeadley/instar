# Record What The Delivery Canary Actually Covers

The push for routine Sol account routing stopped at a release check. That check follows every relative import, including imports used only for TypeScript types. The new routing configuration exposed thirteen account, quota and metadata files that had not been classified in the delivery-canary manifest. The refusal was the intended safety behavior.

The delivery canary certifies seven specific source files involved in receiving and observing Codex messages and recovering their delivery. None of those files changed. Their exact hashes, the combined fingerprint and the signed evidence still match. The newly reached account-selection files do different work, and a type-only dependency path makes them visible to this conservative check without making them part of the delivery test.

This correction gives every newly reached file an explicit reason for sitting outside that canary's scope. It uses the existing fingerprint writer and checker, keeps the signed artifact unchanged, and leaves the push and publication gates in place. Independent review confirmed the boundary and unchanged certified files. This is not a new canary run or a claim that delivery evidence proves account routing; the routing behavior has its own tests.

There is no live account or configuration change here. After this small metadata correction, the Chief can retry the normal push and verification process. Any future change to a certified source, or any new unclassified dependency, still causes the same gate to refuse it.
