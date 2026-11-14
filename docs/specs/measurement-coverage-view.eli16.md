# Which work is actually measured?

The feature board already tells you what the recurring review thinks about features. But that table cannot prove it includes everything. A new feature or a scheduled job can be missing from the review and quietly disappear from the numbers. A healthy-looking percentage can then hide the work that never had a measurement in the first place.

This change adds a coverage panel to that same board. It reads the feature switches, decision census, loaded jobs and work tracker directly. It keeps switched-on features, disabled jobs and completed work in the count. Model definitions come from the validated local producer catalog. Being listed does not mean a model is available or permitted for a task. A partial catalog stays visibly incomplete. The panel says which entries have a recorded baseline comparison, which have no measurement linked, which need more evidence, and which sources could not be read. Counts refer to entries in each existing inventory; the same item on two machines is counted twice.

A measurement declaration and a verified numeric comparison are different. A feature may still have its written contract after it graduates out of active evaluation. The panel keeps that declaration and says evaluation is inactive. When more than one measurement is linked to a feature, it asks for review instead of choosing the most flattering one. A parent's evidence never fills a child's gap, or the other way around.

This is a read-only view. It cannot switch on features, promote a rollout, start repairs or stop normal service. The existing review remains responsible for deciding what the evidence means and taking corrective action. A full-looking coverage bar is not proof that outcomes improved. The companion contract-authoring increment supplies exact links for jobs and decisions. If a link or real proof is missing, this panel shows that gap.

The panel uses short labels, a coverage bar and expandable lists on the existing phone and desktop board. It preserves the source read times and tells you when display rows were omitted while keeping them in the total count. A revert removes this panel and read projection without a database migration or state repair.

When a source is unavailable, the warning offers its own question/action. It does not send the reader hunting for a different place on the page.
