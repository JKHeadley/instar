# Secret-Key Diagnostic Policy — Plain-English Overview

The agent already lets each machine choose where its private vault key lives. A normal desktop may use the operating system keychain, while a headless machine may deliberately keep the key in protected local state because its background process cannot reliably open a login keychain. That choice is explicit security policy, not a guess made by diagnostics.

The problem was that the machine health command opened the vault without passing that configured choice. It could therefore describe a file-keyed machine as “keychain-backed,” even though the runtime writers correctly followed the file-key policy. The vault remained encrypted, but the health report could send an operator toward the wrong diagnosis during an outage.

This change makes the health command consume the same existing policy as the vault writers. It does not invent a new key backend, move keys between machines, expose secret values, or automatically change anyone’s configuration. It only makes the diagnostic view agree with the authoritative configured policy.

The adjacent secret-sync regression test also becomes stricter. That test examines one bounded region of the server composition file and counts the two places that must inherit the policy. Previously it proved only that the start marker existed. If the end marker were renamed, the scan could silently continue to the end of the file and pass for the wrong reason. The test now proves both markers exist in the correct order before it examines the region.

The safety rule is simple: security diagnostics derive their labels from the same policy that controls runtime behavior, and source-scanning tests prove every boundary they depend on. Rollback is a small code revert; there is no data migration or persistent format change.
