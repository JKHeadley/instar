# macOS vault keychain write input

The shared and per-agent writers use the Apple Security tool with a fixed argv and a bounded command over stdin. Only selectors that can be safely quoted are accepted. Both output streams are discarded. A fresh read of the exact slot must match the expected value before success. The update mode replaces the earlier delete-then-add sequence.

Existing file and password fallback behavior is preserved. A current backend failure uses the fixed non-value-bearing diagnostic. Tests use synthetic keys and a fake keychain runner. No live keychain write was attempted.
