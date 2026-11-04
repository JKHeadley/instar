# The Development page says when automatic merging is stopped

**What this changes, in plain words.** Automatic merging can be stopped, by the operator or by the agent. While it is stopped, pull requests that pass their checks just wait. The console's Development page barely showed this. On first load it often opens the Feedback section, so Shipping stays a closed bar, and the only notice and the only button to turn merging back on sat at the bottom of that closed section, under the whole pull request list. The operator hit this three times.

Now, when merging is stopped, a card at the very top of the page says so and carries the button. The Shipping bar says it too, and the headline stops claiming nothing needs you. When merging is not stopped the page looks as it did.

**What did not change.** The button does exactly what it did: it asks for the PIN and sends it once to the same server route with the same stop records. Nothing here changes who may turn merging back on, and the server still makes that decision. There is no new route.

**Two small fixes in the same page.** A link to one section now opens that section even if the page is already open. It applies once per arrival, so the 30-second refresh does not undo what the operator opens or closes, or scroll the page again. And the stray text "[object HTMLParagraphElement]" under Feedback is gone. A list of notes nested inside another list was being turned into text, because the shared page builder only flattened one level. Fixing the builder removes that mistake from every console page.

**If it is wrong.** Revert the commit. It only changes browser-side files, with no stored state or settings.
