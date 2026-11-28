# Make Small Dashboard Controls Easier To Tap

Some links at the bottom of dashboard pages had a hit area only as tall as the text. Several filters and disclosure buttons were also shorter than the dashboard's phone target. This made ordinary actions harder to tap, especially on small screens.

The shared styles give those footer links and controls more room for a touch or click. Footer links still wrap with the surrounding text, and disclosures keep their usual arrow and keyboard behavior. Normal links inside messages and document text keep their existing layout. The three controls already covered by the separate Settings fix stay with that change.

The audit exercises the same dashboard pages at phone and laptop sizes with synthetic data. It checks actual hit areas through each changed control's center and looks for horizontal page overflow. A disposable browser is enough for this layout check, and the audit makes no application writes.
