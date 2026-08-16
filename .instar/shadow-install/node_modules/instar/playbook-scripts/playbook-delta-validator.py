#!/usr/bin/env python3
"""
Playbook Deterministic Delta Validator — non-LLM rule engine.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 3.9).

The primary defense against persistent prompt injection via reflector
manipulation. All proposed context deltas must pass this deterministic
validator before reaching the manifest. No LLM calls — pure rule logic.

Implements 12 validation rules:
  1. Schema validity
  2. Tag vocabulary check
  3. Size limit (500 tokens)
  4. ID format validation
  5. Category policy compliance
  6. Confidence gate (>= 0.85 for auto-processing)
  7. HITL triggers (identity/safety, contradictions)
  8. Counter bounds (+1/-1 per delta)
  9. Provenance required (create ops need evidence)
  10. Duplicate check (exact ID match)
  11. Rate limit (50 deltas/session/lifecycle run)
  12. Quarantine check

Usage:
    python3 playbook-delta-validator.py validate <delta_json>
    python3 playbook-delta-validator.py validate-file <path>
    python3 playbook-delta-validator.py validate-batch <jsonl_path> [--session AUT-XXXX-wo]
    python3 playbook-delta-validator.py schema
"""

import json
import os
import re
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
GOVERNANCE_FILE = _paths.governance
MANIFEST_FILE = _paths.manifest
REJECTED_LOG = _paths.rejected_log

DELTA_ID_PATTERN = re.compile(r"^delta-[a-f0-9]{12}$")
ITEM_ID_PATTERN = re.compile(r"^/context/[a-z]+/[a-z0-9/-]+$")
# Default session pattern — overridden by governance_overrides.source_session_pattern or playbook-config.json
DEFAULT_SESSION_PATTERN = r"^AUT-\d+-wo$"

VALID_OPERATIONS = ["create", "update_counter", "update_content", "retire", "merge", "promote", "resolve_quarantine"]
VALID_EVIDENCE_TYPES = ["exit_code", "http_status", "test_result", "human_verification"]
VALID_MEMORY_TYPES = ["fact", "experiential", "episodic", "procedural", "historical"]

MAX_INLINE_TOKENS = 500
RATE_LIMIT_PER_SESSION = 50
CONFIDENCE_THRESHOLD = 0.85


def _estimate_tokens(text):
    """Rough token estimate: ~4 chars per token for English text."""
    if not text:
        return 0
    return len(text) // 4 + 1


def _load_governance():
    """Load governance policy file."""
    if not os.path.exists(GOVERNANCE_FILE):
        return None
    with open(GOVERNANCE_FILE, "r") as f:
        return json.load(f)


def _get_session_pattern(governance):
    """Get session ID validation pattern from governance or config.

    Resolution order:
    1. playbook-config.json governance_overrides.source_session_pattern
    2. context-governance.json governance_overrides.source_session_pattern
    3. DEFAULT_SESSION_PATTERN (Dawn's AUT-XXXX-wo format)
    """
    # Try playbook-config.json first
    config_file = os.path.join(PROJECT_DIR, ".instar", "playbook", "playbook-config.json")
    if not os.path.exists(config_file):
        # Fallback: check project root for config (Dawn's layout)
        config_file = os.path.join(PROJECT_DIR, "playbook-config.json")
    if os.path.exists(config_file):
        try:
            with open(config_file, "r") as f:
                config = json.load(f)
            pattern = config.get("governance_overrides", {}).get("source_session_pattern")
            if pattern:
                return re.compile(pattern)
        except (json.JSONDecodeError, OSError):
            pass

    # Try governance file
    if governance:
        pattern = governance.get("governance_overrides", {}).get("source_session_pattern")
        if pattern:
            return re.compile(pattern)

    return re.compile(DEFAULT_SESSION_PATTERN)


def _load_manifest():
    """Load manifest for duplicate/quarantine checks."""
    if not os.path.exists(MANIFEST_FILE):
        return {"items": []}
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _log_rejection(delta, rule, reason):
    """Log rejected delta to the rejection log."""
    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "delta_id": delta.get("delta_id", "unknown"),
        "rule": rule,
        "reason": reason,
        "source_session": delta.get("source_session", "unknown"),
    }
    os.makedirs(os.path.dirname(os.path.abspath(REJECTED_LOG)), exist_ok=True)
    with open(REJECTED_LOG, "a") as f:
        f.write(json.dumps(entry, separators=(",", ":")) + "\n")


class ValidationResult:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.route = "standard"  # standard | pending_review | reject

    @property
    def valid(self):
        return len(self.errors) == 0

    def add_error(self, rule, message):
        self.errors.append({"rule": rule, "message": message})
        self.route = "reject"

    def add_warning(self, rule, message):
        self.warnings.append({"rule": rule, "message": message})

    def route_to_review(self, rule, message):
        self.warnings.append({"rule": rule, "message": message, "requires_review": True})
        if self.route != "reject":
            self.route = "pending_review"

    def to_dict(self):
        return {
            "valid": self.valid,
            "route": self.route,
            "errors": self.errors,
            "warnings": self.warnings,
        }


def validate_delta(delta, governance=None, manifest=None, session_delta_count=0):
    """
    Validate a single delta against all 12 rules.

    Returns a ValidationResult with errors, warnings, and routing decision.
    """
    result = ValidationResult()
    governance = governance or _load_governance()
    manifest = manifest or _load_manifest()

    # Rule 1: Schema validity
    _rule_schema_validity(delta, result)
    if not result.valid:
        return result  # Stop early on schema failure

    # Rule 2: Tag vocabulary
    _rule_tag_vocabulary(delta, governance, result)

    # Rule 3: Size limit
    _rule_size_limit(delta, result)

    # Rule 4: ID format (session pattern is governance-configurable)
    _rule_id_format(delta, governance, result)

    # Rule 5: Category policy
    _rule_category_policy(delta, governance, manifest, result)

    # Rule 6: Confidence gate
    _rule_confidence_gate(delta, result)

    # Rule 7: HITL triggers
    _rule_hitl_triggers(delta, manifest, result)

    # Rule 8: Counter bounds
    _rule_counter_bounds(delta, result)

    # Rule 9: Provenance required
    _rule_provenance_required(delta, result)

    # Rule 10: Duplicate check
    _rule_duplicate_check(delta, manifest, result)

    # Rule 11: Rate limit
    _rule_rate_limit(delta, session_delta_count, result)

    # Rule 12: Quarantine check
    _rule_quarantine_check(delta, manifest, result)

    # Rule 13: PII screening (Phase 2)
    _rule_pii_screening(delta, result)

    return result


def _rule_schema_validity(delta, result):
    """Rule 1: Delta matches required schema."""
    required = ["delta_id", "timestamp", "source_session", "operation", "reflector_confidence"]
    for field in required:
        if field not in delta:
            result.add_error("schema_validity", f"Missing required field: {field}")

    if "operation" in delta and delta["operation"] not in VALID_OPERATIONS:
        result.add_error("schema_validity", f"Invalid operation: {delta['operation']}")

    if "reflector_confidence" in delta:
        conf = delta["reflector_confidence"]
        if not isinstance(conf, (int, float)) or conf < 0.0 or conf > 1.0:
            result.add_error("schema_validity", f"reflector_confidence must be 0.0-1.0, got: {conf}")

    if "evidence" in delta:
        if not isinstance(delta["evidence"], list):
            result.add_error("schema_validity", "evidence must be an array")
        else:
            for i, ev in enumerate(delta["evidence"]):
                if not isinstance(ev, dict):
                    result.add_error("schema_validity", f"evidence[{i}] must be an object")
                elif "type" not in ev or "value" not in ev:
                    result.add_error("schema_validity", f"evidence[{i}] missing required fields (type, value)")
                elif ev["type"] not in VALID_EVIDENCE_TYPES:
                    result.add_error("schema_validity", f"evidence[{i}] invalid type: {ev['type']}")


def _rule_tag_vocabulary(delta, governance, result):
    """Rule 2: All tags in payload.tags exist in governance vocabulary."""
    if not governance:
        result.add_warning("tag_vocabulary", "Governance file not found, skipping tag check")
        return

    payload = delta.get("payload", {})
    tags = payload.get("tags", {})
    vocab = governance.get("tag_vocabulary", {})

    allowed_domains = set(vocab.get("domains", []))
    allowed_qualifiers = set(vocab.get("qualifiers", []))
    max_domains = vocab.get("max_domain_tags", 2)
    max_qualifiers = vocab.get("max_qualifier_tags", 3)

    domains = tags.get("domains", [])
    qualifiers = tags.get("qualifiers", [])

    for d in domains:
        if d not in allowed_domains:
            result.add_error("tag_vocabulary", f"Unknown domain tag: {d}")

    for q in qualifiers:
        if q not in allowed_qualifiers:
            result.add_error("tag_vocabulary", f"Unknown qualifier tag: {q}")

    if len(domains) > max_domains:
        result.add_error("tag_vocabulary", f"Too many domain tags: {len(domains)} (max {max_domains})")

    if len(qualifiers) > max_qualifiers:
        result.add_error("tag_vocabulary", f"Too many qualifier tags: {len(qualifiers)} (max {max_qualifiers})")


def _rule_size_limit(delta, result):
    """Rule 3: content_inline <= 500 tokens."""
    payload = delta.get("payload", {})
    content = payload.get("content_inline", "")
    if content:
        tokens = _estimate_tokens(content)
        if tokens > MAX_INLINE_TOKENS:
            result.add_error("size_limit", f"content_inline too large: ~{tokens} tokens (max {MAX_INLINE_TOKENS})")


def _rule_id_format(delta, governance, result):
    """Rule 4: IDs match required patterns. Session pattern is governance-configurable."""
    delta_id = delta.get("delta_id", "")
    if delta_id and not DELTA_ID_PATTERN.match(delta_id):
        result.add_error("id_format", f"Invalid delta_id format: {delta_id} (expected delta-[a-f0-9]{{12}})")

    target = delta.get("target_item_id", "")
    if target and not ITEM_ID_PATTERN.match(target):
        result.add_error("id_format", f"Invalid target_item_id format: {target}")

    session = delta.get("source_session", "")
    session_pattern = _get_session_pattern(governance)
    if session and not session_pattern.match(session):
        result.add_error("id_format", f"Invalid source_session format: {session} (pattern: {session_pattern.pattern})")


def _rule_category_policy(delta, governance, manifest, result):
    """Rule 5: Operation respects category policy."""
    if not governance:
        return

    operation = delta.get("operation", "")
    target_id = delta.get("target_item_id", "")
    policies = governance.get("category_policies", {})

    # Determine category from target item
    category = _get_item_category(target_id, manifest)
    if not category:
        # For create operations, check payload
        category = delta.get("payload", {}).get("category", "")

    if category and category in policies:
        policy = policies[category]
        if operation == "retire" and policy.get("retirement_policy") == "manual_only":
            result.add_error("category_policy", f"Cannot auto-retire {category} items (policy: manual_only)")
        if operation == "update_counter" and policy.get("scoring_exempt"):
            result.add_error("category_policy", f"Cannot update counters on scoring-exempt {category} items")


def _rule_confidence_gate(delta, result):
    """Rule 6: Route low-confidence deltas to review."""
    confidence = delta.get("reflector_confidence", 0)
    if confidence < CONFIDENCE_THRESHOLD:
        result.route_to_review("confidence_gate",
                               f"Confidence {confidence} below threshold {CONFIDENCE_THRESHOLD}")


def _rule_hitl_triggers(delta, manifest, result):
    """Rule 7: Mandatory human review triggers."""
    operation = delta.get("operation", "")
    target_id = delta.get("target_item_id", "")
    payload = delta.get("payload", {})

    category = _get_item_category(target_id, manifest)
    if not category:
        category = payload.get("category", "")

    # Promotion to identity/safety
    if operation == "promote" and category in ("identity", "safety"):
        result.route_to_review("hitl_trigger", f"Promotion to {category} requires human review")

    # Retirement of identity/safety
    if operation == "retire" and category in ("identity", "safety"):
        result.route_to_review("hitl_trigger", f"Retirement of {category} item requires human review")

    # Contradiction detection
    if operation == "update_content" and target_id:
        existing = _get_manifest_item(target_id, manifest)
        if existing and existing.get("content_inline") and payload.get("content_inline"):
            result.route_to_review("hitl_trigger", "Content update on existing item requires review for contradiction")


def _rule_counter_bounds(delta, result):
    """Rule 8: Counter increments are +1 or -1 per delta."""
    if delta.get("operation") != "update_counter":
        return

    payload = delta.get("payload", {})
    field = payload.get("field")
    increment = payload.get("increment")

    if field not in ("helpful", "misleading", None):
        result.add_error("counter_bounds",
                         f"Counter field must be 'helpful' or 'misleading', got: {field}")

    if increment is not None:
        if increment not in (1, -1, 0.5, -0.5):
            result.add_error("counter_bounds",
                             f"Counter increment for {field} must be +/-1 or +/-0.5, got: {increment}")


def _rule_provenance_required(delta, result):
    """Rule 9: Create operations must include evidence."""
    if delta.get("operation") != "create":
        return

    evidence = delta.get("evidence", [])
    if not evidence:
        result.add_error("provenance_required", "Create operations must include at least one evidence entry")


def _rule_duplicate_check(delta, manifest, result):
    """Rule 10: Check for duplicate items (exact ID match)."""
    if delta.get("operation") != "create":
        return

    target_id = delta.get("target_item_id", "")
    if not target_id:
        return

    existing = _get_manifest_item(target_id, manifest)
    if existing:
        result.add_warning("duplicate_check",
                           f"Item {target_id} already exists. Consider converting to update_counter.")


def _rule_rate_limit(delta, session_delta_count, result):
    """Rule 11: Max 50 deltas per session per lifecycle run."""
    if session_delta_count >= RATE_LIMIT_PER_SESSION:
        result.add_warning("rate_limit",
                           f"Session has {session_delta_count} deltas (limit: {RATE_LIMIT_PER_SESSION}). Excess queued for next run.")
        result.route_to_review("rate_limit", "Rate limit exceeded, queued for next lifecycle run")


def _rule_quarantine_check(delta, manifest, result):
    """Rule 12: Operations on quarantined items need resolve_quarantine."""
    target_id = delta.get("target_item_id", "")
    operation = delta.get("operation", "")

    if not target_id or operation == "resolve_quarantine":
        return

    existing = _get_manifest_item(target_id, manifest)
    if existing and existing.get("status") == "quarantine":
        result.add_error("quarantine_check",
                         f"Item {target_id} is quarantined. Use operation 'resolve_quarantine' with human evidence.")


def _rule_pii_screening(delta, result):
    """Rule 13 (Phase 2): Screen delta payload for PII patterns."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "playbook_pii_screen",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "playbook-pii-screen.py"))
        pii_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pii_mod)

        screen_result = pii_mod.screen_delta(delta)
        if screen_result.get("has_pii"):
            findings = screen_result.get("findings", [])
            types = set(f["type"] for f in findings)
            result.add_error("pii_screening",
                             f"PII detected in delta payload: {', '.join(types)}. "
                             f"{len(findings)} pattern(s) found.")
    except Exception:
        # PII screening is best-effort — don't block on import failure
        pass


# Helper functions

def _get_item_category(item_id, manifest):
    """Get the category of an item from the manifest."""
    item = _get_manifest_item(item_id, manifest)
    if item:
        return item.get("category", "")
    # Infer from path: /context/{category}/...
    if item_id:
        parts = item_id.strip("/").split("/")
        if len(parts) >= 2:
            return parts[1]
    return ""


def _get_manifest_item(item_id, manifest):
    """Get an item from the manifest by ID."""
    if not manifest:
        return None
    for item in manifest.get("items", []):
        if item.get("id") == item_id:
            return item
    return None


def validate_batch(deltas, session_id=None):
    """Validate a batch of deltas, tracking per-session counts."""
    governance = _load_governance()
    manifest = _load_manifest()
    session_counts = {}
    results = []

    for delta in deltas:
        sid = session_id or delta.get("source_session", "unknown")
        count = session_counts.get(sid, 0)
        r = validate_delta(delta, governance, manifest, count)
        session_counts[sid] = count + 1

        if not r.valid:
            _log_rejection(delta, r.errors[0]["rule"], r.errors[0]["message"])

        results.append({
            "delta_id": delta.get("delta_id", "unknown"),
            **r.to_dict(),
        })

    return results


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "validate":
        if len(sys.argv) < 3:
            print("Usage: playbook-delta-validator.py validate '<json>'", file=sys.stderr)
            sys.exit(1)
        delta = json.loads(sys.argv[2])
        result = validate_delta(delta)
        print(json.dumps(result.to_dict(), indent=2))
        if not result.valid:
            sys.exit(1)

    elif cmd == "validate-file":
        if len(sys.argv) < 3:
            print("Usage: playbook-delta-validator.py validate-file <path>", file=sys.stderr)
            sys.exit(1)
        with open(sys.argv[2], "r") as f:
            delta = json.load(f)
        result = validate_delta(delta)
        print(json.dumps(result.to_dict(), indent=2))
        if not result.valid:
            sys.exit(1)

    elif cmd == "validate-batch":
        if len(sys.argv) < 3:
            print("Usage: playbook-delta-validator.py validate-batch <jsonl_path> [--session AUT-XXXX-wo]", file=sys.stderr)
            sys.exit(1)
        session_id = None
        if "--session" in sys.argv:
            idx = sys.argv.index("--session")
            session_id = sys.argv[idx + 1]

        deltas = []
        with open(sys.argv[2], "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    deltas.append(json.loads(line))

        results = validate_batch(deltas, session_id)
        accepted = sum(1 for r in results if r["valid"] and r["route"] == "standard")
        review = sum(1 for r in results if r["route"] == "pending_review")
        rejected = sum(1 for r in results if not r["valid"])

        print(json.dumps({
            "total": len(results),
            "accepted": accepted,
            "pending_review": review,
            "rejected": rejected,
            "results": results,
        }, indent=2))

        if rejected > 0:
            sys.exit(1)

    elif cmd == "schema":
        print(json.dumps({
            "required_fields": ["delta_id", "timestamp", "source_session", "operation", "reflector_confidence"],
            "operations": VALID_OPERATIONS,
            "evidence_types": VALID_EVIDENCE_TYPES,
            "memory_types": VALID_MEMORY_TYPES,
            "delta_id_pattern": "delta-[a-f0-9]{12}",
            "item_id_pattern": "/context/{category}/{domain}/{slug}",
            "session_id_pattern": "AUT-\\d+-wo",
            "max_inline_tokens": MAX_INLINE_TOKENS,
            "rate_limit_per_session": RATE_LIMIT_PER_SESSION,
            "confidence_threshold": CONFIDENCE_THRESHOLD,
        }, indent=2))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
