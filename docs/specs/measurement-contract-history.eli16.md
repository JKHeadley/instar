# Remember what a measurement meant

The measurement ledger already stores numeric values and evaluation results. An evaluation records a fingerprint of its definition, but the fingerprint cannot explain the old method, threshold or sample requirement. The normal cleanup can also remove an original baseline after ninety days even while the current definition still uses it.

This change keeps a bounded copy of each exact definition in the same ledger. The history view can show the method, accountable owner, targets and sample requirements under that definition's fingerprint. If an older definition was never archived, cannot be read, or does not fit the bounded response, the view says which gap applies. It never invents an old method from today's settings.

A written baseline is still only a declaration. It earns retention only when an exact existing observation corroborates its value, source, time, version and sample count. If conflicting observations appear later, all records at that time remain available while the current definition references the baseline. Keeping them does not resolve the conflict: the baseline remains unusable until independent evidence resolves it.

The archive has explicit storage limits. At capacity it can refresh existing definitions but holds a new evaluation's evidence rather than silently throwing away live proof. Old definitions and their baseline references expire after 180 days without current use. Ordinary services continue if archiving fails. An earlier ready result for the same evaluation slot is conservatively retracted, and the read view also holds it if that retraction cannot be written.

This is an additive record of definitions, not a new measurement registry or a new promotion authority. Reverting the change leaves unused metadata tables that older code ignores. Full verification, deployment, generic effort/job/decision contracts and understandable live evidence remain duties of the original bounded work session. No user configuration is required for this archive increment.
