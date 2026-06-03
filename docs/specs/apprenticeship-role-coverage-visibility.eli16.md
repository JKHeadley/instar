# Apprenticeship role coverage visibility

An apprenticeship has three important roles: overseer, mentor, and mentee.

The mentor-to-mentee loop is the core of the apprenticeship. The mentor gives the mentee work,
reviews what the mentee did, and coaches the mentee forward. The overseer then checks whether the
mentor missed anything.

The problem is that an apprenticeship can look busy while avoiding that hard mentor-to-mentee loop.
It can keep collecting overseer review cycles, while the mentor-to-mentee cycle never happens. That
is drift, and it was not visible enough.

This change adds a read-only visibility surface for that.

Each recorded cycle now has a clear role-axis kind:

- mentor-mentee differential
- overseer-apprentice development review
- overseer-mentee direct
- unknown

Old rows used one generic label, so the system does not guess what they meant. It shows them as
unknown.

The new route is:

`GET /apprenticeship/instances/:id/role-coverage`

It shows whether each role axis has fired, how many cycles each one has, and when each one last
fired. It also returns a warning when the mentor-to-mentee axis is dormant but overseer review has
happened at least twice.

This warning is not a gate. It does not block transitions, stop messages, or close cycles. It only
makes the missing role loop visible so a mentor or overseer can correct course.
