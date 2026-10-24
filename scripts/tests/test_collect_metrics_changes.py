#!/usr/bin/env python3
"""Unit tests for the telemetry collector's change detection.

Covers the drop and gap detectors added for
PROP-INSTAR-COLLECTOR-DROP-DETECTION. The npm snapshots below are copied
verbatim out of ~/.instar/telemetry/telemetry.jsonl so the fixtures are the
real runs, not invented numbers. The 2026-10-18 run is the incident that
motivated the work: a -56.9% week with a three-day interior zero run that the
collector recorded as `change_notes: []`.

Run:
    python3 -m unittest discover -s scripts/tests
    pytest scripts/tests
"""

import importlib.util
import json
import pathlib
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "collect-metrics.py"
_spec = importlib.util.spec_from_file_location("collect_metrics", MODULE_PATH)
collect_metrics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collect_metrics)


def days(*pairs):
    return [{"date": date, "downloads": downloads} for date, downloads in pairs]


# --- Real runs from the telemetry ledger ---------------------------------

# 2026-10-16T16:01:25 — steady week, trailing zeros from npm's publishing lag.
REAL_10_16 = {
    "last_day": 813, "last_week": 6624, "last_month": 49161, "end_date": "2026-10-12",
    "daily_breakdown": days(
        ("2026-10-09", 2048), ("2026-10-10", 378), ("2026-10-11", 1220),
        ("2026-10-12", 813), ("2026-10-13", 0), ("2026-10-14", 0),
        ("2026-10-15", 0), ("2026-10-16", 0),
    ),
}

# 2026-10-17T16:02:00 — still stale; five trailing zeros, no interior run.
REAL_10_17 = {
    "last_day": 813, "last_week": 6624, "last_month": 49161, "end_date": "2026-10-12",
    "daily_breakdown": days(
        ("2026-10-10", 378), ("2026-10-11", 1220), ("2026-10-12", 813),
        ("2026-10-13", 0), ("2026-10-14", 0), ("2026-10-15", 0),
        ("2026-10-16", 0), ("2026-10-17", 0),
    ),
}

# 2026-10-18T16:02:29 — THE INCIDENT. npm backfilled 10-16/10-17, which turned
# the 10-13..10-15 zeros into an interior run and dropped the week 57%.
# Recorded change_notes at the time: [].
REAL_10_18 = {
    "last_day": 441, "last_week": 2852, "last_month": 41335, "end_date": "2026-10-17",
    "daily_breakdown": days(
        ("2026-10-11", 1220), ("2026-10-12", 813), ("2026-10-13", 0),
        ("2026-10-14", 0), ("2026-10-15", 0), ("2026-10-16", 441),
        ("2026-10-17", 250), ("2026-10-18", 0),
    ),
}

# 2026-10-19T16:01:37 — a further -31% slide: real, but a normal variation that
# must NOT trip the drop floor. The interior gap is still present.
REAL_10_19 = {
    "last_day": 465, "last_week": 1969, "last_month": 41514, "end_date": "2026-10-18",
    "daily_breakdown": days(
        ("2026-10-12", 813), ("2026-10-13", 0), ("2026-10-14", 0),
        ("2026-10-15", 0), ("2026-10-16", 441), ("2026-10-17", 250),
        ("2026-10-18", 465), ("2026-10-19", 0),
    ),
}

# 2026-10-23T16:01:31 — flat stale week; the whole zero run is trailing lag.
REAL_10_23 = {
    "last_day": 465, "last_week": 1969, "last_month": 41514, "end_date": "2026-10-18",
    "daily_breakdown": days(
        ("2026-10-16", 441), ("2026-10-17", 250), ("2026-10-18", 465),
        ("2026-10-19", 0), ("2026-10-20", 0), ("2026-10-21", 0),
        ("2026-10-22", 0), ("2026-10-23", 0),
    ),
}

# A control week: healthy traffic every day, flat week over week.
CONTROL_WEEK_PREV = {
    "last_day": 400, "last_week": 2800, "last_month": 12000, "end_date": "2026-09-10",
    "daily_breakdown": days(
        ("2026-09-04", 400), ("2026-09-05", 400), ("2026-09-06", 400),
        ("2026-09-07", 400), ("2026-09-08", 400), ("2026-09-09", 400),
        ("2026-09-10", 400),
    ),
}
CONTROL_WEEK = {
    "last_day": 410, "last_week": 2810, "last_month": 12000, "end_date": "2026-09-11",
    "daily_breakdown": days(
        ("2026-09-05", 400), ("2026-09-06", 400), ("2026-09-07", 400),
        ("2026-09-08", 400), ("2026-09-09", 400), ("2026-09-10", 400),
        ("2026-09-11", 410),
    ),
}


class ChangeDetectionTestCase(unittest.TestCase):
    """Base class that writes a one-row telemetry ledger for the previous run."""

    def detect(self, current_npm, prev_npm=None, write_history=True, trends=None):
        """Run detect_significant_changes against a temp state dir.

        `trends` mirrors what main() puts on the snapshot via compute_trends();
        its npm_week_prev is the week-ago drop baseline.
        """
        with tempfile.TemporaryDirectory() as state_dir:
            if write_history:
                ledger = pathlib.Path(state_dir) / "telemetry.jsonl"
                prev_snapshot = {"timestamp": "2026-01-01T00:00:00+00:00", "npm": prev_npm or {}}
                ledger.write_text(json.dumps(prev_snapshot) + "\n")
            snapshot = {"npm": current_npm}
            if trends is not None:
                snapshot["trends"] = trends
            return collect_metrics.detect_significant_changes(snapshot, state_dir)

    def kinds(self, current_npm, prev_npm=None, write_history=True, trends=None):
        changes = self.detect(current_npm, prev_npm, write_history, trends)
        return {n["kind"] for n in collect_metrics.build_change_notes(changes)}


class TestTheIncident(ChangeDetectionTestCase):
    """The 2026-10-18 run must no longer be silent."""

    def test_reports_both_a_drop_and_a_gap(self):
        changes = self.detect(REAL_10_18, REAL_10_17)
        self.assertIn("npm_drop", changes, "the -57% week must be flagged")
        self.assertIn("npm_gap", changes, "the 10-13..10-15 zero run must be flagged")

    def test_drop_carries_the_real_magnitude(self):
        drop = self.detect(REAL_10_18, REAL_10_17)["npm_drop"]
        self.assertEqual(drop["previous"], 6624)
        self.assertEqual(drop["current"], 2852)
        self.assertEqual(drop["ratio"], 0.43)
        self.assertAlmostEqual(drop["pct_change"], -56.9, places=1)

    def test_gap_names_the_exact_span(self):
        gap = self.detect(REAL_10_18, REAL_10_17)["npm_gap"]
        self.assertEqual(gap["longest_days"], 3)
        self.assertEqual(gap["start"], "2026-10-13")
        self.assertEqual(gap["end"], "2026-10-15")

    def test_change_notes_carry_the_drop_and_gap_kinds(self):
        self.assertEqual(self.kinds(REAL_10_18, REAL_10_17), {"drop", "gap"})


# Real `trends` blocks from the same ledger rows. npm_week_prev is the
# last_week of the oldest of the last 7 rows -- a true week-over-week baseline.
TRENDS_10_17 = {"npm_day_prev": 813, "npm_day_prev_end_date": "2026-10-12", "npm_week_prev": 13497}
TRENDS_10_18 = {"npm_day_prev": 813, "npm_day_prev_end_date": "2026-10-12", "npm_week_prev": 9580}
TRENDS_10_19 = {"npm_day_prev": 441, "npm_day_prev_end_date": "2026-10-17", "npm_week_prev": 7750}


class TestWeekAgoBaseline(ChangeDetectionTestCase):
    """The npm_week_prev baseline, which sees what run-to-run cannot."""

    def test_catches_a_sustained_slide_a_day_before_the_cliff(self):
        """The real 2026-10-17 run.

        Run-to-run was flat (6,624 both runs) so a previous-run comparison is
        blind to it, but the week had already halved against the week-ago row
        (13,497 -> 6,624). This fires a day BEFORE the 10-18 cliff.
        """
        no_baseline = self.detect(REAL_10_17, REAL_10_16)
        self.assertNotIn("npm_drop", no_baseline,
                         "run-to-run is flat here, so it cannot see the slide")

        changes = self.detect(REAL_10_17, REAL_10_16, trends=TRENDS_10_17)
        self.assertIn("npm_drop", changes)
        drop = changes["npm_drop"]
        self.assertEqual(drop["baseline"], "week_prev")
        self.assertEqual(drop["previous"], 13497)
        self.assertAlmostEqual(drop["pct_change"], -50.9, places=1)

    def test_the_incident_reports_the_steeper_week_ago_decline(self):
        """2026-10-18 trips both baselines; the steeper one is reported.

        -70.2% against the week-ago row (9,580), -56.9% against the previous
        run (6,624). The originating review quoted both figures.
        """
        drop = self.detect(REAL_10_18, REAL_10_17, trends=TRENDS_10_18)["npm_drop"]
        self.assertEqual(drop["baseline"], "week_prev")
        self.assertEqual(drop["previous"], 9580)
        self.assertAlmostEqual(drop["pct_change"], -70.2, places=1)
        self.assertEqual(drop["comparisons"]["prev_run"]["previous"], 6624)
        self.assertEqual(drop["comparisons"]["prev_run"]["ratio"], 0.43)
        self.assertEqual(drop["comparisons"]["week_prev"]["ratio"], 0.3)

    def test_both_baselines_are_recorded_even_when_one_is_quiet(self):
        drop = self.detect(REAL_10_17, REAL_10_16, trends=TRENDS_10_17)["npm_drop"]
        self.assertEqual(sorted(drop["comparisons"]), ["prev_run", "week_prev"])
        self.assertEqual(drop["comparisons"]["prev_run"]["ratio"], 1.0)

    def test_the_note_names_which_baseline_tripped(self):
        changes = self.detect(REAL_10_18, REAL_10_17, trends=TRENDS_10_18)
        note = next(n for n in collect_metrics.build_change_notes(changes) if n["kind"] == "drop")
        self.assertIn("week-ago run", note["message"])
        self.assertIn("9,580", note["message"])

    def test_a_healthy_week_ago_baseline_stays_quiet(self):
        changes = self.detect(REAL_10_19, REAL_10_18,
                              trends={"npm_week_prev": 2500})
        self.assertNotIn("npm_drop", changes, "1969 vs 2500 is -21%, above the floor")

    def test_missing_or_zero_week_prev_is_ignored(self):
        for value in (None, 0, "x"):
            with self.subTest(value=value):
                changes = self.detect(REAL_10_17, REAL_10_16,
                                      trends={"npm_week_prev": value})
                self.assertNotIn("npm_drop", changes)


class TestDropDetection(ChangeDetectionTestCase):
    """Isolate the drop check from the gap check."""

    def test_drop_fires_with_no_interior_zero_days(self):
        """A clean week that halves: only the drop check can catch this."""
        prev = {"last_week": 2800, "end_date": "2026-09-10",
                "daily_breakdown": days(("2026-09-09", 400), ("2026-09-10", 400))}
        current = {"last_week": 1200, "end_date": "2026-09-11",
                   "daily_breakdown": days(("2026-09-10", 400), ("2026-09-11", 300))}
        self.assertEqual(self.kinds(current, prev), {"drop"})

    def test_moderate_decline_is_not_a_drop(self):
        """The real -31% slide on 2026-10-19 is a normal variation, not an alert."""
        changes = self.detect(REAL_10_19, REAL_10_18)
        self.assertNotIn("npm_drop", changes)
        self.assertIn("npm_gap", changes, "the interior gap is still present that day")
        self.assertEqual(self.kinds(REAL_10_19, REAL_10_18), {"gap"})

    def test_boundary_just_above_the_floor_is_quiet(self):
        prev = {"last_week": 1000, "end_date": "d1", "daily_breakdown": []}
        current = {"last_week": 600, "end_date": "d2", "daily_breakdown": []}
        self.assertNotIn("npm_drop", self.detect(current, prev))

    def test_boundary_just_below_the_floor_fires(self):
        prev = {"last_week": 1000, "end_date": "d1", "daily_breakdown": []}
        current = {"last_week": 599, "end_date": "d2", "daily_breakdown": []}
        self.assertIn("npm_drop", self.detect(current, prev))

    def test_a_week_that_grows_is_not_a_drop(self):
        prev = {"last_week": 1000, "end_date": "d1", "daily_breakdown": []}
        current = {"last_week": 5000, "end_date": "d2", "daily_breakdown": []}
        self.assertNotIn("npm_drop", self.detect(current, prev))

    def test_missing_or_zero_previous_week_cannot_divide(self):
        for prev_week in (None, 0):
            with self.subTest(prev_week=prev_week):
                prev = {"last_week": prev_week, "end_date": "d1", "daily_breakdown": []}
                current = {"last_week": 10, "end_date": "d2", "daily_breakdown": []}
                self.assertNotIn("npm_drop", self.detect(current, prev))

    def test_stale_data_does_not_suppress_the_drop(self):
        """The guard this restructure exists for.

        The old code returned early on stale data, so a collapsed week that
        arrived on a stale run was never flagged. Staleness must skip only the
        spike comparison.
        """
        prev = {"last_week": 6624, "end_date": "2026-10-18", "daily_breakdown": []}
        current = {"last_week": 1200, "end_date": "2026-10-18", "daily_breakdown": []}
        changes = self.detect(current, prev)
        self.assertIn("npm_stale", changes)
        self.assertIn("npm_drop", changes, "stale data must not hide a collapsed week")


class TestGapDetection(ChangeDetectionTestCase):
    """Isolate the gap check from the drop check."""

    def test_trailing_zero_run_is_publishing_lag_not_a_gap(self):
        """2026-10-23: five trailing zeros, flat week. Nothing to report but staleness."""
        changes = self.detect(REAL_10_23, REAL_10_23)
        self.assertNotIn("npm_gap", changes)
        self.assertNotIn("npm_drop", changes)
        self.assertEqual(self.kinds(REAL_10_23, REAL_10_23), {"stale"})

    def test_the_10_17_run_has_no_interior_run(self):
        """Same zeros as the incident, but nothing had backfilled after them yet."""
        self.assertNotIn("npm_gap", self.detect(REAL_10_17, REAL_10_16))

    def test_leading_zero_run_is_not_a_gap(self):
        current = {"last_week": 900, "end_date": "d2",
                   "daily_breakdown": days(("d1", 0), ("d2", 0), ("d3", 300), ("d4", 600))}
        self.assertNotIn("npm_gap", self.detect(current, {"last_week": 900, "end_date": "d1"}))

    def test_single_interior_zero_day_is_below_the_floor(self):
        current = {"last_week": 900, "end_date": "d4",
                   "daily_breakdown": days(("d1", 300), ("d2", 0), ("d3", 300), ("d4", 300))}
        self.assertNotIn("npm_gap", self.detect(current, {"last_week": 900, "end_date": "d1"}))

    def test_two_interior_zero_days_reach_the_floor(self):
        current = {"last_week": 900, "end_date": "d5",
                   "daily_breakdown": days(("d1", 300), ("d2", 0), ("d3", 0), ("d4", 300), ("d5", 300))}
        gap = self.detect(current, {"last_week": 900, "end_date": "d1"})["npm_gap"]
        self.assertEqual(gap["longest_days"], 2)

    def test_unknown_download_count_is_not_a_zero_day(self):
        """A hole in the feed must never be reported as a gap."""
        current = {"last_week": 900, "end_date": "d5",
                   "daily_breakdown": days(("d1", 300), ("d2", None), ("d3", None), ("d4", 300), ("d5", 300))}
        self.assertNotIn("npm_gap", self.detect(current, {"last_week": 900, "end_date": "d1"}))

    def test_stale_data_does_not_suppress_the_gap(self):
        """The other half of the restructure guard: a stalled npm pipeline is
        what produces zero days, so staleness must not hide the gap."""
        stale_with_gap = {
            "last_day": 300, "last_week": 900, "last_month": 4000, "end_date": "2026-10-18",
            "daily_breakdown": days(
                ("2026-10-12", 300), ("2026-10-13", 0), ("2026-10-14", 0),
                ("2026-10-15", 0), ("2026-10-16", 300), ("2026-10-17", 300),
            ),
        }
        prev = {"last_day": 300, "last_week": 900, "last_month": 4000,
                "end_date": "2026-10-18", "daily_breakdown": []}
        changes = self.detect(stale_with_gap, prev)
        self.assertIn("npm_stale", changes)
        self.assertIn("npm_gap", changes, "stale data must not hide a reporting gap")
        self.assertEqual(changes["npm_gap"]["longest_days"], 3)

    def test_an_unknown_day_cannot_anchor_a_gap_boundary(self):
        """An unknown day is neither zero nor traffic.

        If an unknown day were classified as traffic it could act as the
        boundary that makes a leading zero run look interior, inventing a gap
        out of a hole in the feed. Mutation-derived: the earlier unknown-day
        test passed either way, because None reads as 'nonzero' when the
        numeric guard is removed and that also yields no gap.
        """
        leading = {"last_week": 900, "end_date": "d4",
                   "daily_breakdown": days(("d1", None), ("d2", 0), ("d3", 0), ("d4", 100))}
        self.assertNotIn("npm_gap", self.detect(leading, {"last_week": 900, "end_date": "d0"}),
                         "an unknown day must not anchor the leading edge")
        self.assertEqual(collect_metrics.find_interior_zero_runs(leading["daily_breakdown"]), [])

        trailing = {"last_week": 900, "end_date": "d4",
                    "daily_breakdown": days(("d1", 100), ("d2", 0), ("d3", 0), ("d4", None))}
        self.assertNotIn("npm_gap", self.detect(trailing, {"last_week": 900, "end_date": "d0"}),
                         "an unknown day must not anchor the trailing edge")
        self.assertEqual(collect_metrics.find_interior_zero_runs(trailing["daily_breakdown"]), [])

    def test_gap_is_detected_with_no_history_at_all(self):
        """The gap check reads only the current snapshot."""
        changes = self.detect(REAL_10_18, write_history=False)
        self.assertIn("npm_gap", changes)
        self.assertNotIn("npm_drop", changes, "a drop needs a previous run to compare against")

    def test_every_interior_run_is_returned(self):
        breakdown = days(
            ("d1", 100), ("d2", 0), ("d3", 0), ("d4", 100),
            ("d5", 0), ("d6", 0), ("d7", 0), ("d8", 100), ("d9", 0),
        )
        runs = collect_metrics.find_interior_zero_runs(breakdown)
        self.assertEqual(
            [(r["start"], r["end"], r["days"]) for r in runs],
            [("d2", "d3", 2), ("d5", "d7", 3)],
        )

    def test_empty_and_missing_breakdowns_are_safe(self):
        for breakdown in (None, [], [{}], [{"date": "d1"}]):
            with self.subTest(breakdown=breakdown):
                self.assertEqual(collect_metrics.find_interior_zero_runs(breakdown), [])


class TestControlWeek(ChangeDetectionTestCase):
    """A healthy week must stay completely silent."""

    def test_control_week_emits_no_notes(self):
        changes = self.detect(CONTROL_WEEK, CONTROL_WEEK_PREV)
        self.assertEqual(changes, {}, f"expected no findings, got {sorted(changes)}")
        self.assertEqual(collect_metrics.build_change_notes(changes), [])

    def test_control_week_does_not_trip_the_spike_alert_either(self):
        self.assertEqual(self.kinds(CONTROL_WEEK, CONTROL_WEEK_PREV), set())


class TestSpikeStillWorks(ChangeDetectionTestCase):
    """The pre-existing behaviour must survive the restructure."""

    def test_spike_is_still_detected(self):
        prev = {"last_day": 100, "last_week": 700, "end_date": "d1", "daily_breakdown": []}
        current = {"last_day": 500, "last_week": 1100, "end_date": "d2", "daily_breakdown": []}
        changes = self.detect(current, prev)
        self.assertIn("npm_spike", changes)
        self.assertEqual(changes["npm_spike"]["ratio"], 5.0)

    def test_spike_is_still_skipped_when_data_is_stale(self):
        prev = {"last_day": 100, "last_week": 700, "end_date": "same", "daily_breakdown": []}
        current = {"last_day": 500, "last_week": 700, "end_date": "same", "daily_breakdown": []}
        changes = self.detect(current, prev)
        self.assertIn("npm_stale", changes)
        self.assertNotIn("npm_spike", changes)


class TestChangeNoteRendering(unittest.TestCase):
    """The note has to reach a human, not just the JSON."""

    def test_notes_carry_a_kind_and_a_message(self):
        changes = {
            "npm_drop": {"baseline": "prev_run", "previous": 6624, "current": 2852,
                         "ratio": 0.43, "pct_change": -56.9, "end_date": "2026-10-17"},
            "npm_gap": {"runs": [{"start": "2026-10-13", "end": "2026-10-15", "days": 3}],
                        "longest_days": 3, "start": "2026-10-13", "end": "2026-10-15",
                        "end_date": "2026-10-17"},
        }
        notes = collect_metrics.build_change_notes(changes)
        self.assertEqual([n["kind"] for n in notes], ["drop", "gap"])
        for note in notes:
            self.assertTrue(note["message"].strip(), "every note needs a message")

    def test_format_summary_prints_the_drop_note(self):
        """'Done when a dry run prints the drop note' — format_summary ignored
        change_notes entirely before this change, so even the stale note was
        invisible in the human-readable output."""
        snapshot = {
            "timestamp": "2026-10-18T16:02:29+00:00",
            "npm": REAL_10_18,
            "github": {},
            "change_notes": collect_metrics.build_change_notes(
                {"npm_drop": {"baseline": "prev_run", "previous": 6624, "current": 2852,
                              "ratio": 0.43, "pct_change": -56.9, "end_date": "2026-10-17"}}
            ),
        }
        summary = collect_metrics.format_summary(snapshot)
        self.assertIn("Change Notes:", summary)
        self.assertIn("[drop]", summary)
        self.assertIn("6,624", summary)
        self.assertIn("2,852", summary)
        self.assertIn("57%", summary)

    def test_a_drop_without_a_baseline_still_renders(self):
        """A renderer must not crash on a partial dict."""
        notes = collect_metrics.build_change_notes(
            {"npm_drop": {"previous": 100, "current": 10, "ratio": 0.1, "pct_change": -90.0}}
        )
        self.assertEqual(notes[0]["kind"], "drop")
        self.assertIn("90%", notes[0]["message"])
        self.assertNotIn("against", notes[0]["message"])

    def test_format_summary_renders_the_npm_counts_themselves(self):
        """Asserted on the npm lines, not on the note text: the drop note
        repeats the same figures, so matching them anywhere in the summary
        would pass even if the npm block rendered nothing but placeholders."""
        summary = collect_metrics.format_summary(
            {"timestamp": "t", "npm": REAL_10_18, "github": {}, "change_notes": []}
        )
        lines = {l.split(":")[0].strip(): l for l in summary.splitlines() if ":" in l}
        self.assertIn("441", lines["Last 24h"])
        self.assertIn("2,852", lines["Last 7d"])
        self.assertIn("41,335", lines["Last 30d"])

    def test_format_summary_survives_a_failed_npm_fetch(self):
        """Regression: npm returns None for every metric when the fetch fails,
        and the ',' format spec raised on None, crashing the whole summary.
        Happened on 2026-04-16 and 2026-08-29 in the real ledger."""
        snapshot = {
            "timestamp": "2026-08-29T16:00:57+00:00",
            "npm": {"last_day": None, "last_week": None, "last_month": None,
                    "end_date": None, "daily_breakdown": []},
            "github": {"clones_14d": {"total": None, "unique": None}},
            "change_notes": [],
        }
        summary = collect_metrics.format_summary(snapshot)
        self.assertIn("Last 24h:", summary)
        self.assertIn("?", summary)

    def test_format_summary_still_renders_legacy_string_notes(self):
        """Historical ledger rows hold plain strings; re-rendering must not crash."""
        snapshot = {"timestamp": "t", "npm": {}, "github": {},
                    "change_notes": ["legacy string note"]}
        self.assertIn("legacy string note", collect_metrics.format_summary(snapshot))


class TestAlertDelivery(unittest.TestCase):
    """A detector whose alert cannot be delivered is not a detector."""

    def test_prefers_an_explicit_portal_dir_that_has_the_sender(self):
        with tempfile.TemporaryDirectory() as d:
            sender = pathlib.Path(d) / collect_metrics.TELEGRAM_SEND_REL
            sender.parent.mkdir(parents=True, exist_ok=True)
            sender.write_text("#!/usr/bin/env python3\n")
            original = collect_metrics.PORTAL_DIR_CANDIDATES
            collect_metrics.PORTAL_DIR_CANDIDATES = (d, "~/Projects/the-portal")
            try:
                self.assertEqual(collect_metrics.resolve_portal_dir(), pathlib.Path(d))
            finally:
                collect_metrics.PORTAL_DIR_CANDIDATES = original

    def test_does_not_pick_a_directory_without_the_sender(self):
        with tempfile.TemporaryDirectory() as d:
            original = collect_metrics.PORTAL_DIR_CANDIDATES
            collect_metrics.PORTAL_DIR_CANDIDATES = (d, None)
            try:
                self.assertIsNone(collect_metrics.resolve_portal_dir())
            finally:
                collect_metrics.PORTAL_DIR_CANDIDATES = original

    def test_unresolvable_portal_dir_fails_soft_and_loud(self):
        """Returns False rather than raising, and says so on stderr."""
        original = collect_metrics.PORTAL_DIR_CANDIDATES
        collect_metrics.PORTAL_DIR_CANDIDATES = (None,)
        try:
            self.assertFalse(collect_metrics.send_telegram_alert("x"))
        finally:
            collect_metrics.PORTAL_DIR_CANDIDATES = original

    def test_the_documents_path_is_not_preferred(self):
        """~/Documents is unreliable on this machine; it must be the last resort."""
        candidates = [c for c in collect_metrics.PORTAL_DIR_CANDIDATES if c]
        documents = [i for i, c in enumerate(candidates) if "Documents" in c]
        projects = [i for i, c in enumerate(candidates) if c.startswith("~/Projects")]
        self.assertTrue(documents and projects, "both candidates should be listed")
        self.assertGreater(min(documents), max(projects),
                           "~/Documents must come after ~/Projects")


if __name__ == "__main__":
    unittest.main()
