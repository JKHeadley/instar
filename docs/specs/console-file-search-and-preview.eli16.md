# Finding files and seeing pictures on the Files page — the plain-English overview

## What this is

The dashboard has a Files page that lets you look through the agent's project folder from a phone or a computer. Two things were missing. First, the "Find a file" box only searched folders you had already opened, so a file three folders down could not be found by name. Second, pictures could not be shown; the page said "Images are not previewed here yet" and you had to download them.

## What changes

Typing in "Find a file" now searches every folder you have allowed the page to browse, not just the ones you opened. Results show the file name and the folder it is in, and tapping one opens it. Opening a picture (PNG, JPEG, GIF or WebP) now shows the picture right on the page, with the Download button still under it.

## What already existed, and what stays the same

The Files page already had strict rules: some files are never shown at all (the agent's private keys and anything named like a password or token file), you choose which folders can be browsed, and nothing outside the project is ever reachable, even through a shortcut link. The new search and the new picture view go through exactly those same rules, step by step. Nothing new is shown that you could not already open or download.

## Safeguards

The search has limits so it can never hog the machine: it stops after 200 results, 20,000 entries or two seconds, skips the big generated folders, and tells you when it stopped early. For pictures, the server looks at the first few bytes of the file to see what it really is. Only the four common picture types are shown. SVG pictures are never shown, because they are really code and could run something. A file that is only named like a picture is refused. Pictures over 5 MB, or over the size limit you set for the page, are not shown; you can still download them.

## What you need to decide

Nothing. This is a small, read-only addition that a revert fully undoes.

## How agents learn about it

The agent learns about file search from one small text file in the folder of feature notes. Every agent, new or old, gets that note in its instructions on its next update, and a second update changes nothing. Earlier versions of this change edited the big instructions template and the update code directly. That kept colliding with other changes to the same two files, and the update step once ran in the wrong order, so the note moved to the feature notes folder.
