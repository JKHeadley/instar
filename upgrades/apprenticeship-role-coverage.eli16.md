# Apprenticeship role coverage visibility

An apprenticeship has three roles: overseer, mentor, and mentee. The important learning loop is the
mentor working directly with the mentee, then the overseer checking what the mentor missed. During
the first real run, Justin caught a problem: the system could keep doing the easier overseer-review
work while the actual mentor-to-mentee learning loop stayed quiet.

This change makes that visible.

Each apprenticeship cycle now has an explicit role-axis kind:

- mentor-mentee differential
- overseer-apprentice development review
- overseer-mentee direct
- unknown

Old cycles used one generic label, so we do not pretend we know what axis they belonged to. They are
shown as unknown.

There is a new read-only route:

`GET /apprenticeship/instances/:id/role-coverage`

It reports, for each axis, whether it has fired, how many cycles it has, and the most recent time it
fired. It also reports dormant axes and a drift warning. The warning turns on when the
mentor-to-mentee axis has not fired, but the overseer review axis has fired at least twice.

The boundary is important: this is only visibility. It does not block an apprenticeship transition,
stop a message, close a cycle, or judge quality. It just makes the missing loop visible so the
overseer and mentor can correct course.
