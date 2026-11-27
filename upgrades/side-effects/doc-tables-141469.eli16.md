# Tables on the document page, in plain English

Instar Documents is the page where you read a document an agent wrote and leave comments on parts of it. It opens in a browser and inside the iPhone app.

Until now, when a document contained a table, the page did not draw a table. Each row came out as one line of small typewriter-style text, with vertical bars between the cells. A table with a few columns turned into a hard-to-read block of bars, and on a phone the long lines wrapped and the columns stopped lining up at all. Justin saw this on a real document and asked for better formatting, at least for tables.

What changes: a table now looks like a table. The columns line up, the header row is bold on a shaded background, there are light lines between rows and columns, and if the document says a column is right-aligned or centred, it is. An empty cell stays empty in its own column, so the rest of the row does not slide left. When a table is wider than a phone screen, only the table scrolls sideways inside its own box; the rest of the page stays still.

What does not change: commenting. You can still select any text in a table, including text that runs from one cell into the next, and leave a comment on it. The comment is stored against exactly the same characters as before, so comments left on table text before this change stay where they were.

How it works, briefly: the agent's server already breaks the document into pieces for the page. It now also says which column each piece of a table row belongs to, and how each column is aligned. The page uses that to draw the cells. The text itself is identical to before, which is what keeps comment positions stable. If a newer page meets an older server that does not send the column information, it shows the old one-line rows instead of breaking.

Nothing to decide here: this is a display fix with no new settings, no new permissions and nothing stored. It reaches the iPhone app too, because the app shows this same page. Undoing it is a single revert.
