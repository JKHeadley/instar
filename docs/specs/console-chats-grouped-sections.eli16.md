# Grouped conversations: Projects apart from Groups (ELI16)

## What this is

The dashboard has a Conversations page. Since #3325 it can show the list "Grouped": conversations that belong together are folded under one row, and a group that is linked to a project the Chief of Staff tracks gets a project mark and a status chip such as "Moving" or "Needs you". On 2026-11-18 the owner reported, from his iPhone, three things that made that list hard to read: projects and plain groups were mixed together under one "Groups" header, some groups showed up with nothing in them ("Untitled group, 0 conversations"), and project groups were named like "Project: Instar topic management", repeating a word the project mark already says. The iPhone app was fixed the same day (apps/instar-ios commit 039e813). This change gives the dashboard the same rules so the two read alike.

## What changes

- The Grouped view now has two sections. "Projects" lists the groups linked to a tracked project, each with its project mark and status chip. "Groups" lists the plain groups, each with its folder and conversation count. A section with nothing in it has no header.
- A group with no conversations (counting the conversations in its sub-groups) is never shown.
- A project group is named by the tracked project's own title when the project has one. Otherwise the group's own title is used with a leading "Project:" or "Project –" (or "Project -", or an em dash, any capitalisation) taken off. Only the word "Project" followed by a separator is removed, so "Projector setup" or "My Project: x" stay exactly as typed, and a title that would become empty is kept as it was. Plain groups keep their titles unchanged.

## What does not change

No server code, route, or stored data changes. The All view, pins, the Chief of Staff row at the top, the "Not in a group yet" section, the "Open project" link and the status chip words are all as before. If the projects read fails, every group is a plain group, as before.

## Safeguards

Titles still reach the page only as text, never as markup. Nothing is hidden that has content: only groups with zero conversations are left out, and every conversation stays reachable through its group, "Not in a group yet", or the All view.

## What you need to decide

Nothing. This is a small display change matching the iPhone app, and a revert undoes it completely.
