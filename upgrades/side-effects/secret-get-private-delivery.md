# Private secret retrieval

A bare CLI lookup exits before reading a secret. A selected field is delivered to the selected command's stdin with both child output streams suppressed. Trusted built-ins that need a value in-process can receive it through an explicitly configured inherited pipe on descriptor 3. Secret values are excluded from the helper's stdout and stderr. Aggregate arrays are no longer a value-bearing lookup. Existing installs receive the helper and load-assessment template through the ordinary update migration.

This intentionally changes bare CLI behavior. Custom consumers should use explicit command delivery. The helper cannot control where an explicitly chosen child later stores its input. No real credentials are used in verification.
