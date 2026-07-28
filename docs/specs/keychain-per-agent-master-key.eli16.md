# Secrets boot guard + orphan-proof stores

Each instar agent encrypts its secrets with a master key. The 2026-06-05 incident: one agent's freshly-generated key landed in the machine-shared keychain slot, every other agent's secrets stopped decrypting, the failure was swallowed by an empty catch, and the server crash-looped minutes later on a confusing type error.

A parallel PR (#810) fixed the key storage itself (per-agent slots, self-describing vault format, automatic repair). This change fixes the layers around it: a secrets failure that would break messaging now stops the boot immediately with a message naming exactly which fields are affected (instead of leaking `{secret:true}` placeholder objects into the running config); the shared cross-agent secret vault refuses to mint a fresh key over data it would orphan; and secret-store failures are reported instead of silently looking like "no secrets stored."
