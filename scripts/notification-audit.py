#!/usr/bin/env python3
"""Summarize Agent Motel notification metadata without printing message content."""

from __future__ import annotations

import argparse
import json
import subprocess
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


KINDS = ("attention", "idle", "share", "pr", "decision")
REPEAT_SECONDS = (60, 300, 600)


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def iso(value: datetime | None) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else "unavailable"


def load_jsonl(path: Path) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    invalid = 0
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        return rows, invalid
    for line in lines:
        if not line.strip():
            continue
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
            else:
                invalid += 1
        except json.JSONDecodeError:
            invalid += 1
    return rows, invalid


def rows_in_window(rows: Iterable[dict[str, Any]], field: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for row in rows:
        value = row.get(field)
        if not isinstance(value, str):
            continue
        try:
            timestamp = parse_time(value)
        except ValueError:
            continue
        if start <= timestamp <= end:
            selected.append(row)
    return selected


def coverage(rows: Iterable[dict[str, Any]], field: str) -> tuple[datetime | None, datetime | None]:
    timestamps: list[datetime] = []
    for row in rows:
        value = row.get(field)
        if not isinstance(value, str):
            continue
        try:
            timestamps.append(parse_time(value))
        except ValueError:
            pass
    return (min(timestamps), max(timestamps)) if timestamps else (None, None)


def unusable_timestamps(rows: Iterable[dict[str, Any]], field: str) -> int:
    unusable = 0
    for row in rows:
        value = row.get(field)
        if not isinstance(value, str):
            unusable += 1
            continue
        try:
            parse_time(value)
        except ValueError:
            unusable += 1
    return unusable


def daemon_journal(start: datetime, end: datetime) -> dict[str, Any]:
    command = [
        "journalctl", "--user", "-u", "am-daemon.service", "--no-pager", "-o", "json",
        "--since", start.isoformat(), "--until", end.isoformat(),
    ]
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        return {"available": False, "reason": type(error).__name__}
    if result.returncode != 0:
        return {"available": False, "reason": f"journalctl exited {result.returncode}"}
    rows = []
    invalid = 0
    for line in result.stdout.splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            invalid += 1
    timestamps: list[datetime] = []
    unusable_timestamp = 0
    for row in rows:
        raw_timestamp = str(row.get("__REALTIME_TIMESTAMP", ""))
        if not raw_timestamp.isdigit():
            unusable_timestamp += 1
            continue
        try:
            timestamps.append(datetime.fromtimestamp(int(raw_timestamp) / 1_000_000, timezone.utc))
        except (OverflowError, OSError, ValueError):
            unusable_timestamp += 1
    return {
        "available": True,
        "rows": len(rows),
        "invalid": invalid,
        "unusable_timestamp": unusable_timestamp,
        "first": min(timestamps) if timestamps else None,
        "last": max(timestamps) if timestamps else None,
        "priorities": Counter(str(row.get("PRIORITY", "unknown")) for row in rows),
    }


def format_counter(counter: Counter[Any]) -> str:
    return ", ".join(f"{key}={value}" for key, value in sorted(counter.items(), key=lambda item: str(item[0]))) or "none"


def main() -> int:
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notifications", type=Path, default=home / ".agent-manager/notifications.jsonl")
    parser.add_argument("--lifecycle", type=Path, default=home / ".agent-manager/logs/lifecycle-audit.jsonl")
    parser.add_argument("--daemon-log", type=Path, default=home / ".agent-manager/logs/daemon.log")
    parser.add_argument("--end", type=parse_time, default=datetime.now(timezone.utc), help="UTC/offset timestamp; defaults to now")
    parser.add_argument("--days", type=float, default=7.0)
    args = parser.parse_args()
    end = args.end.astimezone(timezone.utc)
    start = end - timedelta(days=args.days)

    notifications, notification_invalid = load_jsonl(args.notifications)
    lifecycle, lifecycle_invalid = load_jsonl(args.lifecycle)
    notification_first, notification_last = coverage(notifications, "at")
    lifecycle_first, lifecycle_last = coverage(lifecycle, "timestamp")
    notification_bad_time = unusable_timestamps(notifications, "at")
    lifecycle_bad_time = unusable_timestamps(lifecycle, "timestamp")
    window_notifications = rows_in_window(notifications, "at", start, end)
    window_lifecycle = rows_in_window(lifecycle, "timestamp", start, end)
    lifecycle_daemon = [row for row in window_lifecycle if row.get("source") == "daemon"]
    journal = daemon_journal(start, end)

    kind_counts = Counter(str(row.get("kind", "unknown")) for row in window_notifications)
    agent_counts: dict[str, Counter[str]] = defaultdict(Counter)
    for row in window_notifications:
        agent = row.get("agent") if isinstance(row.get("agent"), str) and row.get("agent") else "(none)"
        agent_counts[agent][str(row.get("kind", "unknown"))] += 1

    idle = sorted(
        (row for row in window_notifications if row.get("kind") == "idle" and isinstance(row.get("at"), str)),
        key=lambda row: parse_time(row["at"]),
    )
    repeats: dict[int, Counter[str]] = {seconds: Counter() for seconds in REPEAT_SECONDS}
    previous: dict[str, datetime] = {}
    for row in idle:
        agent = row.get("agent") if isinstance(row.get("agent"), str) and row.get("agent") else "(none)"
        timestamp = parse_time(row["at"])
        if agent in previous:
            elapsed = (timestamp - previous[agent]).total_seconds()
            for seconds in REPEAT_SECONDS:
                if elapsed <= seconds:
                    repeats[seconds][agent] += 1
        previous[agent] = timestamp

    print("# Notification audit")
    print()
    print(f"Window: `{iso(start)}` through `{iso(end)}` ({args.days:g} days, inclusive).")
    print("Notification titles and messages are intentionally neither selected nor emitted.")
    print()
    print("## Source coverage")
    print()
    print("| Source | Available coverage | Window records | Invalid JSON/non-object | Unusable timestamp |")
    print("|---|---:|---:|---:|---:|")
    print(f"| `{args.notifications}` | {iso(notification_first)} to {iso(notification_last)} | {len(window_notifications)} | {notification_invalid} | {notification_bad_time} |")
    print(f"| `{args.lifecycle}` | {iso(lifecycle_first)} to {iso(lifecycle_last)} | {len(window_lifecycle)} | {lifecycle_invalid} | {lifecycle_bad_time} |")
    if journal["available"]:
        print(f"| user journal `am-daemon.service` | {iso(journal['first'])} to {iso(journal['last'])} | {journal['rows']} | {journal['invalid']} | {journal['unusable_timestamp']} |")
    else:
        print(f"| user journal `am-daemon.service` | unavailable ({journal['reason']}) | 0 | 0 | n/a |")
    daemon_mtime = datetime.fromtimestamp(args.daemon_log.stat().st_mtime, timezone.utc) if args.daemon_log.exists() else None
    print(f"| `{args.daemon_log}` | mtime {iso(daemon_mtime)} | not parsed (legacy text log) | n/a | n/a |")
    print()
    print(f"Lifecycle rows sourced by the daemon: **{len(lifecycle_daemon)}**; action/phase: " + format_counter(Counter(f"{row.get('action', 'unknown')}/{row.get('phase', 'unknown')}" for row in lifecycle_daemon)) + ".")
    if journal["available"]:
        print("Daemon journal priorities: " + format_counter(journal["priorities"]) + ".")
    print()
    print("## Attempts by kind")
    print()
    print("| Kind | Attempts | Share |")
    print("|---|---:|---:|")
    total = len(window_notifications)
    for kind in KINDS:
        count = kind_counts[kind]
        share = count / total if total else 0
        print(f"| {kind} | {count} | {share:.1%} |")
    for kind in sorted(set(kind_counts) - set(KINDS)):
        count = kind_counts[kind]
        print(f"| {kind} | {count} | {count / total if total else 0:.1%} |")
    print(f"| **Total** | **{total}** | **{'100.0%' if total else '0.0%'}** |")
    print()
    print("## Attempts by agent and kind")
    print()
    print("| Agent | Total | Attention | Idle | Share | PR | Decision |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for agent, counts in sorted(agent_counts.items(), key=lambda item: (-sum(item[1].values()), item[0])):
        print(f"| {agent} | {sum(counts.values())} | {counts['attention']} | {counts['idle']} | {counts['share']} | {counts['pr']} | {counts['decision']} |")
    print()
    print("## Same-agent idle repeats")
    print()
    print("Each threshold is cumulative and compares an idle attempt with that agent's immediately preceding idle attempt inside the window.")
    print()
    print("| Maximum interval | Repeats | Share of idle attempts |")
    print("|---|---:|---:|")
    for seconds in REPEAT_SECONDS:
        count = sum(repeats[seconds].values())
        print(f"| {seconds}s | {count} | {count / len(idle) if idle else 0:.1%} |")
    print()
    print("Per-agent repeat counts:")
    print()
    for seconds in REPEAT_SECONDS:
        print(f"- <= {seconds}s: {format_counter(repeats[seconds])}")
    print()
    print("## Measurement limits")
    print()
    print("- The notification JSONL is an attempt/relay journal, not proof that an operating-system notification was displayed or seen.")
    print("- No focused window or selected-agent fields exist in the available notification and lifecycle records, so focused-agent suppression is not measurable from these logs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
