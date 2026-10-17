"""Freeze usage for one isolated Codex checkout; never called by the publisher."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
rows = list(connection.execute(
    "SELECT id,rollout_path,agent_path,model,reasoning_effort,source FROM threads WHERE cwd=? ORDER BY id",
    (sys.argv[2],),
))
root_thread = sys.argv[3]
selected = {root_thread}
while True:
    children = set()
    for thread, _rollout, _role, _model, _effort, source in rows:
        try:
            parent = json.loads(source).get("subagent", {}).get("thread_spawn", {}).get("parent_thread_id")
        except (ValueError, AttributeError):
            parent = None
        if parent in selected:
            children.add(thread)
    if children <= selected:
        break
    selected |= children
agents = []
for thread, rollout, role, model, effort, _source in rows:
    if thread not in selected:
        continue
    source = Path(rollout).read_bytes()
    usage = None
    requests = []
    complete_requests = True
    keys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]
    completed = False
    for line in source.splitlines():
        event = json.loads(line)
        payload = event.get("payload", {})
        if event.get("type") == "event_msg":
            if payload.get("type") == "task_started":
                completed = False
            if payload.get("type") == "task_complete":
                completed = True
            if payload.get("type") == "token_count" and payload.get("info"):
                info = payload["info"]
                current = info["total_token_usage"]
                if current != usage:
                    last = info.get("last_token_usage", {})
                    # Repeated snapshots are not new requests. Missing fields, counter resets,
                    # or dropped events must not produce a plausible but incomplete price.
                    if all(isinstance(current.get(key), int) and isinstance(last.get(key), int)
                           and current[key] - (usage or {}).get(key, 0) == last[key] for key in keys):
                        requests.append({key: last[key] for key in keys})
                    else:
                        complete_requests = False
                usage = current
    if usage is None or not completed:
        raise RuntimeError(f"Incomplete Codex usage receipt: {thread}")
    agents.append({"threadId": thread, "role": role or "/root", "model": model,
                   "reasoningEffort": effort, "completed": completed,
                   "usage": {key: usage[key] for key in keys if key in usage},
                   "apiRequests": requests if complete_requests else None,
                   "rolloutSha256": hashlib.sha256(source).hexdigest()})
print(json.dumps(agents))
