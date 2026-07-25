# Side-effects review: capability registry follow-up

- This follow-up changes one behavior from Increment 0: manifest-derived capability rows now carry `evidence.manifestVerifiedAt` from the canonical manifest verification stamp.
- That producer activates the status matrix's manifest-staleness arm; before this change, that arm could never fire because no adapter populated the field.
- The adapter test now asserts the canonical doorway prefix without pinning one specific model id, so reviewed manifest model rotation does not create a false failure.
- No routes, mesh traffic, durable schema changes, or fleet behavior are added.
- Follow-up tests now assert both the manifest stamp producer and the stale-manifest status arm.
- Real-manifest adapter output is now validated through `validateProjection`; non-ISO sentinel stamps are treated as absent, and the 45-day manifest window is honored.
