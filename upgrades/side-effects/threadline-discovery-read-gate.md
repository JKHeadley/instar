# Side-effects review for Threadline discovery classification

The server table names the exact two installed Threadline discovery tools. The generated hook uses the same names. An unknown tool, a nested alias or a Threadline mutation remains governed by the existing rules. No new trust grant or legacy fallback rule is written.

The gate classifies the registered lookup call as a read. Threadline checks its discovery scope, and permissions to send, pair or change trust remain governed. Local discovery can refresh its own cache, with no change to peer state. The runtime does not infer messaging authority from lookup results.

Existing agents receive the generated built-in hook through the normal migration. No new setting, migration of permission data, network destination or service allowlist is introduced. Reverting restores the former classification and false approval request. No permission records need to be reverted.
