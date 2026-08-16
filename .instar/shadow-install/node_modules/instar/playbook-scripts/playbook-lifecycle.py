#!/usr/bin/env python3
"""
Playbook Lifecycle Job — the macro lifecycle that processes context deltas.

Part of Playbook Phases 1-3 (context-engineering-integration spec, Section 3.5).
Phase 3 adds: full lifecycle orchestration (decay, relevance, retirement,
dedup, token re-estimation) via run_full_lifecycle().

This is the SINGLE WRITER for context-manifest.json. No other process
may write to the manifest. Sessions append to context-deltas.jsonl (lock-free),
and this job processes them atomically under an exclusive flock.

Transaction boundary (from spec Section 3.5):
  acquire_lock(.claude/context-manifest.lock)
    -> read context-manifest.json (current state)
    -> read context-deltas.jsonl (pending deltas)
    -> filter out already-applied deltas (idempotency)
    -> validate deltas via deterministic validator
    -> resolve conflicts (Section 3.6)
    -> compute new manifest state
    -> append to context-history.jsonl (HMAC-chained)
    -> write context-manifest.json.tmp (HMAC-signed)
    -> fsync context-manifest.json.tmp
    -> atomic rename -> context-manifest.json
    -> record applied delta IDs to context-applied-deltas.jsonl
  release_lock(.claude/context-manifest.lock)

Concurrency:
  - Exclusive flock on .claude/context-manifest.lock
  - Stale lock detection: auto-release after 10 minutes (Section 3.7)
  - Sessions use current manifest as-is during lock (read is non-blocking)

Usage:
    python3 playbook-lifecycle.py run [--session SID]     # Process pending deltas
    python3 playbook-lifecycle.py status                   # Show lifecycle status
    python3 playbook-lifecycle.py submit-delta <json>      # Submit a delta for processing
    python3 playbook-lifecycle.py pending                  # Show pending deltas
"""

import fcntl
import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from atomic_write import atomic_write_json, atomic_append
from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
MANIFEST_FILE = _paths.manifest
DELTAS_FILE = os.path.join(PROJECT_DIR, "context-deltas.jsonl")
APPLIED_FILE = os.path.join(PROJECT_DIR, "context-applied-deltas.jsonl")
LOCK_FILE = os.path.join(PROJECT_DIR, "context-manifest.lock")
HISTORY_FILE = _paths.history
SNAPSHOTS_DIR = os.path.join(PROJECT_DIR, "context-snapshots")

STALE_LOCK_SECONDS = 600  # 10 minutes
SNAPSHOT_INTERVAL = 100  # Snapshot every N applied deltas
PENDING_REVIEW_DIR = _paths.pending_review_dir
REJECTED_DELTAS_FILE = _paths.rejected_log


def _import_validator():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_delta_validator",
        os.path.join(SCRIPT_DIR, "playbook-delta-validator.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_history():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_history",
        os.path.join(SCRIPT_DIR, "playbook-history.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_hmac():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_hmac",
        os.path.join(SCRIPT_DIR, "playbook-hmac.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_manifest():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_manifest",
        os.path.join(SCRIPT_DIR, "playbook-manifest.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _count_applied_deltas():
    """Count total applied deltas for snapshot scheduling."""
    if not os.path.exists(APPLIED_FILE):
        return 0
    count = 0
    with open(APPLIED_FILE, "r") as f:
        for line in f:
            if line.strip():
                count += 1
    return count


def _maybe_snapshot(manifest, applied_count):
    """Save a manifest snapshot if we've crossed a snapshot interval boundary."""
    if applied_count <= 0 or applied_count % SNAPSHOT_INTERVAL != 0:
        return None

    os.makedirs(SNAPSHOTS_DIR, exist_ok=True)
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    snapshot_name = f"manifest-snapshot-{applied_count}-{timestamp}.json"
    snapshot_path = os.path.join(SNAPSHOTS_DIR, snapshot_name)
    atomic_write_json(snapshot_path, manifest)
    return snapshot_name


def _load_applied_delta_ids():
    """Load set of already-applied delta IDs for idempotency."""
    ids = set()
    if not os.path.exists(APPLIED_FILE):
        return ids
    with open(APPLIED_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                ids.add(entry.get("delta_id", ""))
            except json.JSONDecodeError:
                continue
    return ids


def _load_pending_deltas():
    """Load all pending deltas from context-deltas.jsonl."""
    deltas = []
    if not os.path.exists(DELTAS_FILE):
        return deltas
    with open(DELTAS_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                delta = json.loads(line)
                deltas.append(delta)
            except json.JSONDecodeError:
                continue
    return deltas


def _load_manifest():
    """Load current manifest."""
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _check_stale_lock():
    """Check if lock file is stale (> 10 minutes old). Returns True if stale."""
    if not os.path.exists(LOCK_FILE):
        return False
    try:
        mtime = os.path.getmtime(LOCK_FILE)
        age = time.time() - mtime
        return age > STALE_LOCK_SECONDS
    except OSError:
        return False


def acquire_lock(timeout=30):
    """
    Acquire exclusive flock on manifest lock file.

    Returns (lock_fd, acquired) tuple.
    If lock is stale (>10 min), auto-releases and re-acquires.
    """
    # Check for stale lock first
    if _check_stale_lock():
        try:
            os.unlink(LOCK_FILE)
        except OSError:
            pass

    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    lock_fd = os.open(LOCK_FILE, os.O_WRONLY | os.O_CREAT, 0o644)

    # Write PID and timestamp for diagnostics
    pid_info = json.dumps({
        "pid": os.getpid(),
        "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    os.ftruncate(lock_fd, 0)
    os.lseek(lock_fd, 0, os.SEEK_SET)
    os.write(lock_fd, pid_info.encode("utf-8"))

    # Try to acquire with timeout
    start = time.time()
    while True:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Update lock file with actual acquisition time
            os.ftruncate(lock_fd, 0)
            os.lseek(lock_fd, 0, os.SEEK_SET)
            info = json.dumps({
                "pid": os.getpid(),
                "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            os.write(lock_fd, info.encode("utf-8"))
            return lock_fd, True
        except (OSError, IOError):
            if time.time() - start > timeout:
                os.close(lock_fd)
                return None, False
            time.sleep(0.5)


def release_lock(lock_fd):
    """Release exclusive flock."""
    if lock_fd is not None:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
        except OSError:
            pass


def _persist_pending_review(pending_review_items):
    """
    Persist pending-review deltas to context-pending-review/ directory.

    Phase 2: Confidence gate routing — deltas below threshold are saved
    with their review reason for human processing.
    """
    if not pending_review_items:
        return []

    os.makedirs(PENDING_REVIEW_DIR, exist_ok=True)
    saved = []
    for item in pending_review_items:
        delta = item.get("delta", {})
        delta_id = delta.get("delta_id", "unknown")
        review_entry = {
            "delta_id": delta_id,
            "submitted_at": delta.get("timestamp", ""),
            "review_requested_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "delta": delta,
            "review_reason": item.get("reason", {}),
            "status": "pending",
        }
        review_path = os.path.join(PENDING_REVIEW_DIR, f"{delta_id}.json")
        atomic_write_json(review_path, review_entry)
        saved.append(delta_id)
    return saved


def _persist_rejected_deltas(rejected_items):
    """
    Persist rejected deltas to context-rejected-deltas.jsonl.

    Per spec Section 3.9: Rejected deltas are written with failing rule,
    delta content, and timestamp for manual audit.
    """
    for item in rejected_items:
        entry = {
            "delta_id": item.get("delta_id", "unknown"),
            "rejected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "reason": item.get("reason", {}),
        }
        atomic_append(REJECTED_DELTAS_FILE, json.dumps(entry, separators=(",", ":")))


def _notify_pending_review(pending_review_items):
    """
    Send Telegram notification about deltas routed to pending review.

    Uses the telegram-reply.py script to notify Justin.
    """
    if not pending_review_items:
        return

    count = len(pending_review_items)
    # Build summary
    lines = [f"Playbook: {count} delta(s) routed to pending review:"]
    for item in pending_review_items[:5]:
        delta = item.get("delta", {})
        reason = item.get("reason", {})
        review_reasons = reason.get("review_reasons", [])
        reason_text = ", ".join(review_reasons) if review_reasons else "below confidence threshold"
        lines.append(f"  - {delta.get('delta_id', '?')} [{delta.get('operation', '?')}] "
                      f"-> {delta.get('target_item_id', '?')} ({reason_text})")
    if count > 5:
        lines.append(f"  ... and {count - 5} more")
    lines.append(f"\nReview: .claude/context-pending-review/")

    message = "\n".join(lines)

    # Try sending via telegram-reply.py (topic 285 = Dawn system topic)
    try:
        import subprocess
        subprocess.run(
            ["python3", os.path.join(SCRIPT_DIR, "telegram-reply.py"), "285"],
            input=message, text=True, timeout=10,
            capture_output=True,
        )
    except Exception:
        pass  # Non-critical — review items are persisted regardless


def _resolve_conflicts(deltas, manifest):
    """
    Resolve conflicts per Section 3.6.

    Returns (resolved_deltas, quarantined_items) where:
    - resolved_deltas: deltas to apply (conflicts resolved)
    - quarantined_items: item IDs that should be quarantined
    """
    # Group deltas by target item
    by_item = {}
    for delta in deltas:
        item_id = delta.get("target_item_id", "")
        by_item.setdefault(item_id, []).append(delta)

    resolved = []
    quarantined = []

    for item_id, item_deltas in by_item.items():
        # Separate by operation type
        counter_updates = [d for d in item_deltas if d.get("operation") == "update_counter"]
        content_updates = [d for d in item_deltas if d.get("operation") == "update_content"]
        retirements = [d for d in item_deltas if d.get("operation") == "retire"]
        promotions = [d for d in item_deltas if d.get("operation") == "promote"]
        creates = [d for d in item_deltas if d.get("operation") == "create"]
        others = [d for d in item_deltas if d.get("operation") not in
                  ("update_counter", "update_content", "retire", "promote", "create")]

        # Counter updates: additive (all applied)
        resolved.extend(counter_updates)

        # Content updates: check for contradictions
        if len(content_updates) > 1:
            # Check for human-verified vs session-generated
            human_verified = [d for d in content_updates
                              if any(e.get("provenance_type") == "human-verified"
                                     for e in d.get("evidence", []))]
            if human_verified:
                # Human-verified wins
                resolved.append(human_verified[0])
            else:
                # Both session-generated: quarantine
                quarantined.append(item_id)
                # Don't apply any content update
        elif content_updates:
            resolved.extend(content_updates)

        # Retirement vs promotion: safety wins
        if retirements and promotions:
            # Retirement takes priority, flag for review
            for d in retirements:
                d.setdefault("_flags", []).append("retirement_over_promotion")
            resolved.extend(retirements)
            # Promotions discarded
        else:
            resolved.extend(retirements)
            resolved.extend(promotions)

        resolved.extend(creates)
        resolved.extend(others)

    return resolved, quarantined


def _apply_delta_to_manifest(delta, manifest):
    """Apply a single validated delta to the manifest state."""
    operation = delta.get("operation")
    target_id = delta.get("target_item_id", "")
    payload = delta.get("payload", {})

    items = manifest.get("items", [])

    if operation == "create":
        # Check if item already exists
        existing = [i for i in items if i.get("id") == target_id]
        if existing:
            return False, "item_already_exists"

        new_item = {
            "id": target_id,
            "category": payload.get("category", "domain"),
            "memory_type": payload.get("memory_type", "fact"),
            "path": payload.get("path", ""),
            "content_inline": payload.get("content_inline", ""),
            "tags": payload.get("tags", {"domains": [], "qualifiers": []}),
            "freshness": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "content_hash": payload.get("content_hash", ""),
            "tokens_est": payload.get("tokens_est", 0),
            "usefulness": {"helpful": 0, "misleading": 0},
            "load_triggers": payload.get("load_triggers", []),
            "dependencies": payload.get("dependencies", []),
            "provenance": delta.get("evidence", []),
            "retirement_policy": payload.get("retirement_policy", "auto"),
            "access_scope": payload.get("access_scope", "global"),
            "inheritance_eligible": payload.get("inheritance_eligible", True),
            "status": "active",
        }
        items.append(new_item)
        manifest["items"] = items
        return True, "created"

    elif operation == "update_counter":
        for item in items:
            if item.get("id") == target_id:
                field = payload.get("field", "helpful")
                increment = payload.get("increment", 1)
                usefulness = item.get("usefulness", {"helpful": 0, "misleading": 0})
                usefulness[field] = usefulness.get(field, 0) + increment
                item["usefulness"] = usefulness
                return True, "counter_updated"
        return False, "item_not_found"

    elif operation == "update_content":
        for item in items:
            if item.get("id") == target_id:
                if "content_inline" in payload:
                    item["content_inline"] = payload["content_inline"]
                if "content_hash" in payload:
                    item["content_hash"] = payload["content_hash"]
                if "path" in payload:
                    item["path"] = payload["path"]
                if "tags" in payload:
                    item["tags"] = payload["tags"]
                item["freshness"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                return True, "content_updated"
        return False, "item_not_found"

    elif operation == "retire":
        for item in items:
            if item.get("id") == target_id:
                item["status"] = "retired"
                item["retired_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                return True, "retired"
        return False, "item_not_found"

    elif operation == "promote":
        for item in items:
            if item.get("id") == target_id:
                if "category" in payload:
                    item["category"] = payload["category"]
                return True, "promoted"
        return False, "item_not_found"

    elif operation == "merge":
        # Merge source into target
        source_id = payload.get("source_item_id", "")
        source = None
        for item in items:
            if item.get("id") == source_id:
                source = item
                break
        if not source:
            return False, "source_not_found"

        for item in items:
            if item.get("id") == target_id:
                # Merge usefulness scores
                u = item.get("usefulness", {"helpful": 0, "misleading": 0})
                su = source.get("usefulness", {"helpful": 0, "misleading": 0})
                u["helpful"] = u.get("helpful", 0) + su.get("helpful", 0)
                u["misleading"] = u.get("misleading", 0) + su.get("misleading", 0)
                item["usefulness"] = u
                # Retire source
                source["status"] = "retired"
                source["retired_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                return True, "merged"
        return False, "target_not_found"

    return False, f"unknown_operation_{operation}"


def submit_delta(delta_json):
    """Submit a delta to the pending queue (append-only, no lock needed)."""
    if isinstance(delta_json, str):
        delta = json.loads(delta_json)
    else:
        delta = delta_json

    # Ensure delta has required fields
    if "delta_id" not in delta:
        import secrets
        delta["delta_id"] = f"delta-{secrets.token_hex(6)}"
    if "timestamp" not in delta:
        delta["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    line = json.dumps(delta, separators=(",", ":"))
    atomic_append(DELTAS_FILE, line)
    return delta["delta_id"]


def _import_failsafe():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_failsafe",
        os.path.join(SCRIPT_DIR, "playbook-failsafe.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_lifecycle(session_id="system"):
    """
    Run the lifecycle job: process all pending deltas atomically.

    This is the core transaction from Section 3.5.
    Includes Section 3.7 failure mode checks before writing.
    """
    validator = _import_validator()
    history = _import_history()
    failsafe = _import_failsafe()

    # Section 3.7: Check write safety before proceeding
    safe, write_mode = failsafe.check_write_safety()
    if not safe:
        return {
            "status": "write_halted",
            "message": f"Manifest writes halted: {write_mode.reason}",
            "degraded_mode": write_mode.to_dict(),
        }

    # Acquire exclusive lock
    lock_fd, acquired = acquire_lock(timeout=30)
    if not acquired:
        return {
            "status": "lock_failed",
            "message": "Could not acquire manifest lock within 30s. Another lifecycle job may be running.",
        }

    try:
        # 1. Read current manifest
        manifest = _load_manifest()
        if not manifest:
            return {"status": "error", "message": "No manifest file. Run playbook-manifest.py init first."}

        # 2. Read pending deltas
        all_deltas = _load_pending_deltas()
        if not all_deltas:
            return {"status": "no_deltas", "message": "No pending deltas to process."}

        # 3. Filter out already-applied (idempotency)
        applied_ids = _load_applied_delta_ids()
        pending = [d for d in all_deltas if d.get("delta_id", "") not in applied_ids]
        if not pending:
            return {
                "status": "all_applied",
                "message": f"All {len(all_deltas)} deltas already applied.",
                "total_deltas": len(all_deltas),
            }

        # 4. Load governance for validator context
        governance = None
        governance_path = os.path.join(PROJECT_DIR, "context-governance.json")
        if os.path.exists(governance_path):
            with open(governance_path, "r") as f:
                governance = json.load(f)

        # 5. Validate deltas
        valid_deltas = []
        rejected = []
        pending_review = []

        for delta in pending:
            result = validator.validate_delta(delta, governance, manifest)
            if result.route == "standard":
                valid_deltas.append(delta)
            elif result.route == "pending_review":
                pending_review.append({"delta": delta, "reason": result.to_dict()})
            else:
                rejected.append({"delta_id": delta.get("delta_id"), "reason": result.to_dict()})

        # 5b. Phase 2: Persist pending-review deltas and notify
        if pending_review:
            _persist_pending_review(pending_review)
            _notify_pending_review(pending_review)

        # 5c. Phase 2: Persist rejected deltas for audit
        if rejected:
            _persist_rejected_deltas(rejected)

        # 6. Resolve conflicts among valid deltas
        resolved_deltas, quarantined_items = _resolve_conflicts(valid_deltas, manifest)

        # 7. Apply quarantine to items
        for item_id in quarantined_items:
            for item in manifest.get("items", []):
                if item.get("id") == item_id:
                    item["status"] = "quarantine"
                    item["quarantined_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # 8. Apply resolved deltas to manifest
        applied = []
        failed = []
        for delta in resolved_deltas:
            success, reason = _apply_delta_to_manifest(delta, manifest)
            if success:
                applied.append(delta)
            else:
                failed.append({"delta_id": delta.get("delta_id"), "reason": reason})

        # 9. Record in history (HMAC-chained)
        for delta in applied:
            history.append_entry(
                delta.get("operation", "unknown"),
                delta.get("target_item_id", "unknown"),
                delta.get("source_session", session_id),
                payload={
                    "delta_id": delta.get("delta_id"),
                    "reflector_confidence": delta.get("reflector_confidence", 0),
                },
            )

        # 10. Update manifest metadata
        manifest["last_lifecycle_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # 11. HMAC-sign and write manifest atomically
        hmac_mod = _import_hmac()
        manifest.pop("hmac_signature", None)
        canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        sig = hmac_mod.sign_content(canonical, hmac_mod.get_key())
        manifest["hmac_signature"] = sig
        atomic_write_json(MANIFEST_FILE, manifest)

        # 12. Record applied delta IDs (idempotency ledger)
        for delta in applied:
            entry = json.dumps({
                "delta_id": delta.get("delta_id"),
                "applied_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "operation": delta.get("operation"),
                "target": delta.get("target_item_id"),
            }, separators=(",", ":"))
            atomic_append(APPLIED_FILE, entry)

        # 13. Snapshot if we crossed a snapshot interval boundary
        total_applied = _count_applied_deltas()
        snapshot_name = _maybe_snapshot(manifest, total_applied)

        return {
            "status": "success",
            "total_pending": len(pending),
            "applied": len(applied),
            "rejected": len(rejected),
            "pending_review": len(pending_review),
            "quarantined": len(quarantined_items),
            "failed": len(failed),
            "manifest_items": len(manifest.get("items", [])),
            "hmac_signature": sig[:16] + "...",
            "snapshot": snapshot_name,
            "total_applied_all_time": total_applied,
            "details": {
                "applied_ids": [d.get("delta_id") for d in applied],
                "rejected": rejected[:5],
                "pending_review_count": len(pending_review),
            },
        }

    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        release_lock(lock_fd)


def lifecycle_status():
    """Show current lifecycle status."""
    all_deltas = _load_pending_deltas()
    applied_ids = _load_applied_delta_ids()
    pending = [d for d in all_deltas if d.get("delta_id", "") not in applied_ids]

    manifest = _load_manifest()
    manifest_items = len(manifest.get("items", [])) if manifest else 0
    manifest_signed = bool(manifest.get("hmac_signature")) if manifest else False
    last_run = manifest.get("last_lifecycle_run", "never") if manifest else "never"

    lock_exists = os.path.exists(LOCK_FILE)
    lock_stale = _check_stale_lock() if lock_exists else False
    lock_info = None
    if lock_exists:
        try:
            with open(LOCK_FILE, "r") as f:
                lock_info = json.loads(f.read())
        except (json.JSONDecodeError, FileNotFoundError):
            pass

    return {
        "total_deltas_submitted": len(all_deltas),
        "total_applied": len(applied_ids),
        "pending": len(pending),
        "manifest_items": manifest_items,
        "manifest_signed": manifest_signed,
        "last_lifecycle_run": last_run,
        "lock": {
            "exists": lock_exists,
            "stale": lock_stale,
            "info": lock_info,
        },
    }


def show_pending():
    """Show pending (unapplied) deltas."""
    all_deltas = _load_pending_deltas()
    applied_ids = _load_applied_delta_ids()
    pending = [d for d in all_deltas if d.get("delta_id", "") not in applied_ids]
    return pending


def _import_decay():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_decay",
        os.path.join(SCRIPT_DIR, "playbook-decay.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_semantic_verify():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_semantic_verify",
        os.path.join(SCRIPT_DIR, "playbook-semantic-verify.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_relevance():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_relevance",
        os.path.join(SCRIPT_DIR, "playbook-relevance.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_retirement():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_retirement",
        os.path.join(SCRIPT_DIR, "playbook-retirement.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_dedup_job():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_dedup_job",
        os.path.join(SCRIPT_DIR, "playbook-dedup-job.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_token_reestimate():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_token_reestimate",
        os.path.join(SCRIPT_DIR, "playbook-token-reestimate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_full_lifecycle(session_id="system", dry_run=False):
    """
    Phase 3: Full lifecycle orchestration.

    Chains all lifecycle operations:
    1. Process pending deltas (existing run_lifecycle)
    2. Semantic verification (fact items against codebase)
    3. Token re-estimation (hash drift detection)
    4. Deduplication job
    5. Relevance scoring (if above capacity threshold)
    6. Archive retired items

    Returns comprehensive result.
    """
    results = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": session_id,
        "dry_run": dry_run,
        "phases": {},
    }

    # Phase 1: Process pending deltas
    try:
        delta_result = run_lifecycle(session_id)
        results["phases"]["delta_processing"] = delta_result
    except Exception as e:
        results["phases"]["delta_processing"] = {"status": "error", "message": str(e)}

    # Phase 2: Semantic verification
    try:
        verify = _import_semantic_verify()
        verify_result = verify.scan_all_facts()
        results["phases"]["semantic_verify"] = {
            "status": verify_result.get("status", "error"),
            "items_scanned": verify_result.get("items_scanned", 0),
            "issues": len(verify_result.get("issues", [])),
        }
        # Generate update deltas for hash drift
        if verify_result.get("issues") and not dry_run:
            update_deltas = verify.generate_update_deltas(verify_result, dry_run=False)
            for delta in update_deltas:
                submit_delta(delta)
            results["phases"]["semantic_verify"]["update_deltas"] = len(update_deltas)
    except Exception as e:
        results["phases"]["semantic_verify"] = {"status": "error", "message": str(e)}

    # Phase 3: Token re-estimation
    try:
        token_mod = _import_token_reestimate()
        token_result = token_mod.recompute_tokens(dry_run=dry_run)
        results["phases"]["token_reestimate"] = {
            "status": token_result.get("status", "error"),
            "items_updated": token_result.get("items_updated", 0),
        }
    except Exception as e:
        results["phases"]["token_reestimate"] = {"status": "error", "message": str(e)}

    # Phase 4: Deduplication
    try:
        dedup_job = _import_dedup_job()
        dedup_result = dedup_job.run_dedup_job(dry_run=dry_run)
        results["phases"]["deduplication"] = {
            "status": dedup_result.get("status", "error"),
            "duplicates": dedup_result.get("total_duplicates", 0),
            "submitted": dedup_result.get("submitted", 0),
        }
    except Exception as e:
        results["phases"]["deduplication"] = {"status": "error", "message": str(e)}

    # Phase 5: Relevance scoring
    try:
        relevance = _import_relevance()
        rel_result = relevance.run_relevance_cycle(dry_run=dry_run)
        results["phases"]["relevance_scoring"] = {
            "status": rel_result.get("status", "error"),
            "candidates": rel_result.get("candidates", 0),
            "below_capacity": rel_result.get("status") == "below_capacity",
        }
    except Exception as e:
        results["phases"]["relevance_scoring"] = {"status": "error", "message": str(e)}

    # Phase 6: Archive retired items
    try:
        retirement = _import_retirement()
        archive_result = retirement.archive_retired(dry_run=dry_run)
        results["phases"]["archival"] = {
            "status": archive_result.get("status", "error"),
            "items_archived": archive_result.get("items_archived", 0),
        }
    except Exception as e:
        results["phases"]["archival"] = {"status": "error", "message": str(e)}

    # Summary
    results["summary"] = {
        "phases_completed": sum(
            1 for p in results["phases"].values()
            if p.get("status") not in ("error",)
        ),
        "phases_failed": sum(
            1 for p in results["phases"].values()
            if p.get("status") == "error"
        ),
        "total_phases": len(results["phases"]),
    }

    return results


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "run-full":
        session_id = "system"
        if "--session" in sys.argv:
            idx = sys.argv.index("--session")
            session_id = sys.argv[idx + 1]
        dry_run = "--dry-run" in sys.argv or "--dry_run" in sys.argv
        result = run_full_lifecycle(session_id, dry_run=dry_run)
        print(json.dumps(result, indent=2))

    elif cmd == "run":
        session_id = "system"
        if "--session" in sys.argv:
            idx = sys.argv.index("--session")
            session_id = sys.argv[idx + 1]
        result = run_lifecycle(session_id)
        print(json.dumps(result, indent=2))
        if result.get("status") == "error":
            sys.exit(1)

    elif cmd == "status":
        result = lifecycle_status()
        print(json.dumps(result, indent=2))

    elif cmd == "submit-delta":
        if len(sys.argv) < 3:
            print("Usage: playbook-lifecycle.py submit-delta '<json>'", file=sys.stderr)
            sys.exit(1)
        delta_json = sys.argv[2]
        delta_id = submit_delta(delta_json)
        print(f"Delta submitted: {delta_id}")

    elif cmd == "pending":
        pending = show_pending()
        if not pending:
            print("No pending deltas.")
        else:
            for d in pending:
                print(f"  {d.get('delta_id', '?')} [{d.get('operation', '?')}] -> {d.get('target_item_id', '?')}")
            print(f"\n{len(pending)} pending delta(s)")

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
