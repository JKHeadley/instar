# Keep vault keys out of keychain failure reports

When Instar saves a vault master key, it first tries the operating system's keychain. If the keychain fails, Instar can still use its existing file fallback. The problem was in the explanation of the failure. The operating system helper can include details about the failed command or its output in an error. Those details can include the value that Instar tried to save, so passing the error to a status or degradation report is unsafe.

For either keychain backend, Instar now reports a fixed explanation. The message tells an operator that the keychain write did not succeed and that the fallback applies. The regression tests use simulated platform commands and synthetic values. They exercise the real error-reporting path and make sure neither a sample key nor arbitrary helper output reaches the report. Historical copies and the separate argument transport risk require their own handling.
