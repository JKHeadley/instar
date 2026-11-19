# Grouped conversations: Projects apart from Groups, no empty groups, project names without "Project:"
<!-- bump: patch -->

## What Changed
In the dashboard's Conversations list, Grouped view now has two sections: "Projects" (groups linked to a project the Chief of Staff tracks, with the project mark and status chip) and "Groups" (plain groups, folder and count). A group with no conversations is never shown, and an empty section has no header. A project group shows the tracked project's own title when there is one, otherwise its own title without a leading "Project:" or "Project –" ("Projector…" is left alone). Same rules as the iPhone app.

## What to Tell Your User
- **Projects apart**: "In the grouped conversation list, projects now sit in their own Projects section above your other groups."
- **No empty groups**: "Groups with nothing in them no longer show up."
- **Cleaner names**: "Project groups use the project's own name, without a 'Project:' in front."

## Summary of New Capabilities
No setup. Display change on the dashboard Conversations page only.

## Evidence
`tests/unit/console-chats-model.test.ts` (prefix rule, display title, sections, empty groups hidden) and `tests/unit/console-chats-page.test.ts` (Projects and Groups headers in order, tracked project title on the row), plus Chromium checks at 390x844 and 1280x728. See upgrades/side-effects/console-chats-grouped-sections.md.
