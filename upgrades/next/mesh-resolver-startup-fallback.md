# Mesh resolver startup fallback

## Summary of New Capabilities

- The server now remains available when optional mesh initialization degrades before its endpoint resolver is constructed.

## Fixed

- Session-pool peer routing falls back to the registry's legacy peer URL instead of crashing startup when the optional mesh resolver is unavailable.

