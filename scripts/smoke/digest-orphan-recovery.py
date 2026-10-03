#!/usr/bin/env python3
"""CRE-1187: offline enqueue -> actual recovery source -> digest reader.

Default asserts the desired safety contract (RED on the current implementation).
--characterize asserts the observed defect without pretending it is fixed.
Supply a pinned owner-digest.py; no credentials or network are used.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import urllib.request


def deny_network(*args, **kwargs):
    raise AssertionError("offline fixture must not access network")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--digest-script", required=True, type=Path)
    parser.add_argument("--characterize", action="store_true")
    args = parser.parse_args()
    urllib.request.urlopen = deny_network
    spec = importlib.util.spec_from_file_location("owner_digest", args.digest_script)
    assert spec is not None and spec.loader is not None
    digest = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(digest)
    inbox = {"id": "00000000-0000-4000-8000-000000000001", "title": "DIGEST-INBOX"}
    origin = {"id": "00000000-0000-4000-8000-000000000002", "status": "blocked",
              "blockedByIssueIds": ["00000000-0000-4000-8000-000000000003"]}
    ask_id = "00000000-0000-4000-8000-000000000003"
    created = []

    def transport(method, path, body):
        if method == "GET" and "/issues?" in path:
            return 200, [inbox]
        if method == "POST" and path.endswith("/issues"):
            card = dict(body, id=ask_id, identifier="TEST-3", companyId="offline-company",
                        createdByAgentId="offline-creator", assigneeAgentId=None,
                        assigneeUserId=None, originKind="manual")
            created.append(card)
            return 201, card
        raise AssertionError(f"unexpected fixture operation: {method} {path}")

    client = digest.Client("https://offline.invalid", "offline-company", transport=transport)
    enqueue_args = SimpleNamespace(origin="TEST-2", origin_id=origin["id"],
        question="Offline decision?", priority="high", recommendation="Wait for digest",
        delay_impact="No production action", answer_mode="single_select",
        option=["yes|Yes", "no|No"], origin_description="")
    result = digest.enqueue(client, enqueue_args)
    assert result["urgent"] is False
    assert len(created) == 1
    ask = created[0]
    origin["blockedByIssueIds"] = [ask_id]

    class QueueClient:
        def __init__(self, card):
            self.card = card
        def children(self, parent_id):
            assert parent_id == inbox["id"]
            return [self.card]
        def comments(self, issue_id):
            return []

    assert len(digest.collect_queue(QueueClient(ask), inbox)["todo"]) == 1
    fixture = {"ask": ask, "origin": origin, "expectPreserved": not args.characterize}
    process = subprocess.run(["node", str(Path(__file__).with_suffix(".mjs"))],
        input=json.dumps(fixture), text=True, capture_output=True, timeout=10)
    if process.returncode:
        print(process.stderr.strip())
        return process.returncode
    recovery = json.loads(process.stdout)
    # Repair itself assigns + queues, but does not check out or create a prompt.
    assert len(digest.collect_queue(QueueClient(recovery["ask"]), inbox)["todo"]) == 1
    if args.characterize:
        # Explicit downstream checkout state projection, not an adapter execution.
        checked_out = dict(recovery["ask"], status="in_progress")
        assert digest.collect_queue(QueueClient(checked_out), inbox)["todo"] == []
        # Ordinary work must retain orphan repair (not a blanket exemption).
        ordinary = dict(ask, title="Ordinary blocker", description="Normal work", parentId=None)
        control = subprocess.run(["node", str(Path(__file__).with_suffix(".mjs"))],
            input=json.dumps({"ask": ordinary, "origin": origin}), text=True,
            capture_output=True, timeout=10)
        assert control.returncode == 0, control.stderr
        paused = subprocess.run(["node", str(Path(__file__).with_suffix(".mjs"))],
            input=json.dumps({"ask": ordinary, "origin": origin, "invokable": False}),
            text=True, capture_output=True, timeout=10)
        assert paused.returncode == 0, paused.stderr
    print(json.dumps({"mode": "characterize" if args.characterize else "safety-contract",
        "digestSha256": hashlib.sha256(args.digest_script.read_bytes()).hexdigest(),
        "enqueueUrgent": result["urgent"], "orphanAssigned": recovery["result"]["assigned"],
        "wake": [call for call in recovery["calls"] if call["type"] == "wake"],
        "originStatus": recovery["origin"]["status"], "queueBeforeCheckout": 1,
        "queueAfterSimulatedCheckout": 0 if args.characterize else None,
        "platformPromptCreated": False, "ordinaryControlPassed": args.characterize,
        "pausedControlPassed": args.characterize}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
