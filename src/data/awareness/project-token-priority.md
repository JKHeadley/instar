---
title: Explicit Project Priority
---

The Work project's High, Normal and Low buttons record the owner's preference. Unset projects are Normal. Read `GET /work/projects` or `GET /chief-of-staff/projects/:key` for the saved priority. Changing it requires the existing owner dashboard unlock: `POST /work/projects/:key/priority` with `{ "priority": "high" }` and a verified operator session. An agent's bearer alone is refused; never fabricate owner proof or infer priority from conversational wording.

Priority is stored separately from the goal, done checks and pause. It survives restart and merges through the existing Chief of Staff journal. It is a signal for the later token-pacing assessment, not authorization to spend more, change models, override manual settings or interrupt work. Do not claim priority already changes account placement. A save is acknowledged only after journal durability; an unconfirmed save must be checked before retrying.
