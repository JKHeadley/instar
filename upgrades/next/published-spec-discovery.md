# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Work search can find a small set of public Instar specifications by filename and link to the exact published revision.

## What to Tell Your User

When Work finds a matching published spec, open its link to see the version that the search checked. Search coverage says whether the published paths could be checked.

## Evidence

Focused unit, HTTP and real server lifecycle tests exercise the private Work session, fixed public metadata request, missing paths and rejected file types. A live GitHub probe confirmed the directory metadata and verified its entry count separately.
