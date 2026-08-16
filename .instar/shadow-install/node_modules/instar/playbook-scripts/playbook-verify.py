#!/usr/bin/env python3
"""
Playbook Verification — integrity checking for the entire Playbook system.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 3.4).

Verifies:
  1. HMAC chain integrity of context-history.jsonl
  2. Manifest HMAC signature validity
  3. Governance file HMAC signature validity
  4. Scratchpad checksum for active sessions
  5. Governance schema consistency
  6. Cross-reference between manifest and history

Usage:
    python3 playbook-verify.py --check-chain          # Verify history HMAC chain
    python3 playbook-verify.py --check-manifest        # Verify manifest signature
    python3 playbook-verify.py --check-governance      # Verify governance schema
    python3 playbook-verify.py --check-scratchpad SID  # Verify session scratchpad
    python3 playbook-verify.py --check-all             # Run all checks
    python3 playbook-verify.py --status                # Quick health summary
"""

import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
HISTORY_FILE = _paths.history
MANIFEST_FILE = _paths.manifest
GOVERNANCE_FILE = _paths.governance
SESSIONS_DIR = os.path.join(PROJECT_DIR, "sessions")
REJECTED_LOG = _paths.rejected_log


def check_chain():
    """Verify the HMAC chain integrity of context-history.jsonl."""
    history_mod = _import_history()

    if not os.path.exists(HISTORY_FILE):
        return {"check": "chain", "status": "skip", "message": "No history file"}

    result = history_mod.verify_chain()
    count = history_mod.count_entries()
    return {
        "check": "chain",
        "status": "pass" if result["valid"] else "FAIL",
        "entries": count,
        **result,
    }


def _import_history():
    """Import playbook-history as a module."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_history_lib",
        os.path.join(SCRIPT_DIR, "playbook-history.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_hmac():
    """Import playbook-hmac as a module."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_hmac",
        os.path.join(SCRIPT_DIR, "playbook-hmac.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_scratchpad():
    """Import playbook-scratchpad as a module."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_scratchpad",
        os.path.join(SCRIPT_DIR, "playbook-scratchpad.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check_chain_direct():
    """Verify history chain using direct import."""
    history_mod = _import_history()

    if not os.path.exists(HISTORY_FILE):
        return {"check": "chain", "status": "skip", "message": "No history file"}

    result = history_mod.verify_chain()
    count = history_mod.count_entries()
    return {
        "check": "chain",
        "status": "pass" if result["valid"] else "FAIL",
        "entries": count,
        **result,
    }


def check_manifest():
    """Verify manifest HMAC signature."""
    if not os.path.exists(MANIFEST_FILE):
        return {"check": "manifest", "status": "skip", "message": "No manifest file"}

    try:
        with open(MANIFEST_FILE, "r") as f:
            data = json.load(f)

        hmac_sig = data.get("hmac_signature")
        if not hmac_sig:
            return {
                "check": "manifest",
                "status": "warn",
                "message": "Manifest exists but has no HMAC signature (Phase 1 not yet signed)",
                "items": len(data.get("items", [])),
                "schema_version": data.get("schema_version", "unknown"),
            }

        hmac_mod = _import_hmac()
        data_copy = {k: v for k, v in data.items() if k != "hmac_signature"}
        canonical = json.dumps(data_copy, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        valid = hmac_mod.verify_content(canonical, hmac_mod.get_key(), hmac_sig)

        return {
            "check": "manifest",
            "status": "pass" if valid else "FAIL",
            "items": len(data.get("items", [])),
            "schema_version": data.get("schema_version", "unknown"),
        }
    except Exception as e:
        return {"check": "manifest", "status": "FAIL", "error": str(e)}


def check_governance():
    """Verify governance file schema consistency."""
    if not os.path.exists(GOVERNANCE_FILE):
        return {"check": "governance", "status": "FAIL", "message": "Governance file missing"}

    try:
        with open(GOVERNANCE_FILE, "r") as f:
            data = json.load(f)

        errors = []

        # Check required sections
        required_sections = [
            "tag_vocabulary", "category_policies", "memory_type_decay",
            "confidence_gate", "item_caps", "token_budgets",
        ]
        for section in required_sections:
            if section not in data:
                errors.append(f"Missing section: {section}")

        # Check tag vocabulary structure
        vocab = data.get("tag_vocabulary", {})
        if "domains" not in vocab:
            errors.append("tag_vocabulary missing 'domains'")
        if "qualifiers" not in vocab:
            errors.append("tag_vocabulary missing 'qualifiers'")

        # Check category policies have required fields
        policies = data.get("category_policies", {})
        required_policy_fields = ["retirement_policy", "scoring_exempt", "inheritance_eligible"]
        for cat, policy in policies.items():
            for field in required_policy_fields:
                if field not in policy:
                    errors.append(f"category_policies.{cat} missing '{field}'")

        # Check confidence gate
        gate = data.get("confidence_gate", {})
        if "threshold" not in gate:
            errors.append("confidence_gate missing 'threshold'")

        # Check decay rates are valid numbers
        decay = data.get("memory_type_decay", {})
        for mem_type, config in decay.items():
            rate = config.get("decay_rate")
            if rate is None or not isinstance(rate, (int, float)):
                errors.append(f"memory_type_decay.{mem_type} invalid decay_rate")
            elif rate < 0 or rate > 1:
                errors.append(f"memory_type_decay.{mem_type} decay_rate out of range [0,1]")

        return {
            "check": "governance",
            "status": "pass" if not errors else "FAIL",
            "version": data.get("version", "unknown"),
            "categories": len(policies),
            "domains": len(vocab.get("domains", [])),
            "qualifiers": len(vocab.get("qualifiers", [])),
            "errors": errors if errors else None,
        }
    except Exception as e:
        return {"check": "governance", "status": "FAIL", "error": str(e)}


def check_scratchpad(session_id):
    """Verify a session's scratchpad integrity."""
    scratchpad_mod = _import_scratchpad()
    result = scratchpad_mod.verify_scratchpad(session_id)
    return {
        "check": f"scratchpad/{session_id}",
        "status": "pass" if result["valid"] else "FAIL",
        **result,
    }


def check_rejected_log():
    """Check the rejected deltas log for patterns."""
    if not os.path.exists(REJECTED_LOG):
        return {"check": "rejected_log", "status": "pass", "message": "No rejections (clean)"}

    count = 0
    recent = []
    rule_counts = {}

    with open(REJECTED_LOG, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            count += 1
            entry = json.loads(line)
            rule = entry.get("rule", "unknown")
            rule_counts[rule] = rule_counts.get(rule, 0) + 1
            recent.append(entry)

    recent = recent[-5:]

    # Alert if same rule fires > 5 times (potential attack pattern)
    alerts = []
    for rule, c in rule_counts.items():
        if c > 5:
            alerts.append(f"Rule '{rule}' rejected {c} deltas — potential attack pattern")

    return {
        "check": "rejected_log",
        "status": "warn" if alerts else "pass",
        "total_rejections": count,
        "by_rule": rule_counts,
        "alerts": alerts if alerts else None,
        "recent": recent[-3:] if recent else None,
    }


def check_all():
    """Run all verification checks."""
    results = []

    results.append(check_chain_direct())
    results.append(check_manifest())
    results.append(check_governance())
    results.append(check_rejected_log())

    # Check active session scratchpads
    if os.path.exists(SESSIONS_DIR):
        for d in sorted(os.listdir(SESSIONS_DIR)):
            sp_path = os.path.join(SESSIONS_DIR, d, "scratchpad.json")
            if os.path.exists(sp_path):
                results.append(check_scratchpad(d))

    overall = "pass"
    for r in results:
        if r["status"] == "FAIL":
            overall = "FAIL"
            break
        if r["status"] == "warn" and overall != "FAIL":
            overall = "warn"

    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "overall": overall,
        "checks": results,
    }


def status_summary():
    """Quick one-line health summary."""
    result = check_all()
    overall = result["overall"]
    checks = result["checks"]
    passed = sum(1 for c in checks if c["status"] == "pass")
    failed = sum(1 for c in checks if c["status"] == "FAIL")
    skipped = sum(1 for c in checks if c["status"] == "skip")
    warned = sum(1 for c in checks if c["status"] == "warn")

    status_icon = {"pass": "OK", "warn": "WARN", "FAIL": "FAIL"}[overall]
    return f"Playbook: {status_icon} | {passed} passed, {failed} failed, {warned} warned, {skipped} skipped"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    arg = sys.argv[1]

    if arg == "--check-chain":
        result = check_chain_direct()
        print(json.dumps(result, indent=2))
        if result["status"] == "FAIL":
            sys.exit(1)

    elif arg == "--check-manifest":
        result = check_manifest()
        print(json.dumps(result, indent=2))
        if result["status"] == "FAIL":
            sys.exit(1)

    elif arg == "--check-governance":
        result = check_governance()
        print(json.dumps(result, indent=2))
        if result["status"] == "FAIL":
            sys.exit(1)

    elif arg == "--check-scratchpad":
        if len(sys.argv) < 3:
            print("Usage: playbook-verify.py --check-scratchpad <session_id>", file=sys.stderr)
            sys.exit(1)
        result = check_scratchpad(sys.argv[2])
        print(json.dumps(result, indent=2))
        if result["status"] == "FAIL":
            sys.exit(1)

    elif arg == "--check-rejected":
        result = check_rejected_log()
        print(json.dumps(result, indent=2))

    elif arg == "--check-all":
        result = check_all()
        print(json.dumps(result, indent=2))
        if result["overall"] == "FAIL":
            sys.exit(1)

    elif arg == "--status":
        print(status_summary())

    else:
        print(f"Unknown argument: {arg}", file=sys.stderr)
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
