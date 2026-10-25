# Feedback triage, phase 1 (ELI16)

Instar agents send in bug reports. They get grouped into work items, and until now nothing happened after that: 426 items sat untouched, all ranked the same, none ever closed.

This change adds a sorter. A strong model reads each item's actual reports and decides one of three things: work on it, hold it for later, or set it aside. It also says how serious it is and why. Plain code double-checks every answer: if the model is unsure, or the evidence was cut short, or the report mentions security or data loss, the item is held rather than set aside.

Nothing is deleted. Held items come back for another look after two weeks, or sooner if new reports arrive; set-aside items come back if new reports arrive. Setting items aside starts in practice mode: it is recorded but not applied until it has proven itself and the operator approves it with the dashboard PIN.

The operator gets at most one short message a day, at 8am, and only when something genuinely needs their decision. The second half of this work, a worker that actually builds fixes for the top items, comes in a separate change.
