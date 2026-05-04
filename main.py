from __future__ import annotations
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pathlib import Path
from typing import Optional, List
import re
import json
import subprocess
import threading
from datetime import date, datetime

TASKS_DIR = Path("/Users/neo/tasks")
TASKS_FILE = TASKS_DIR / "inbox.md"          # single source of truth
ARCHIVE = TASKS_DIR / "archive.md"
TAGS_CONFIG = TASKS_DIR / "tags.json"

app = FastAPI()


# --- Git sync ---

def git_pull():
    try:
        subprocess.run(["git", "pull", "--rebase"], cwd=TASKS_DIR,
                       capture_output=True, timeout=10)
    except Exception:
        pass


def git_push():
    try:
        subprocess.run(["git", "add", "-A"], cwd=TASKS_DIR, capture_output=True)
        r = subprocess.run(["git", "commit", "-m", f"sync: {date.today()}"],
                           cwd=TASKS_DIR, capture_output=True)
        if r.returncode == 0:
            subprocess.run(["git", "push"], cwd=TASKS_DIR,
                           capture_output=True, timeout=15)
    except Exception:
        pass


def sync_bg():
    threading.Thread(target=git_push, daemon=True).start()


@app.on_event("startup")
def startup():
    git_pull()


# --- Parsing ---

TASK_RE = re.compile(r"^- \[([ x])\] (.+)$")
TAG_RE = re.compile(r"#([\w\-]+)", re.UNICODE)


def parse_meta(meta_str: str) -> dict:
    meta: dict = {}
    for part in meta_str.split("|"):
        part = part.strip()
        if re.match(r"^P[1-4]$", part):
            meta["priority"] = part
        elif part.startswith("due:"):
            meta["due"] = part[4:]
        elif part.startswith("repeat:"):
            meta["repeat"] = part[7:]
        elif part.startswith("completed:"):
            meta["completed"] = part[10:]
        elif part.startswith("created:"):
            meta["created"] = part[8:]
        elif part == "pending_delete:1":
            meta["pending_delete"] = True
    return meta


def parse_task_line(line: str, line_no: int) -> Optional[dict]:
    m = TASK_RE.match(line)
    if not m:
        return None
    done = m.group(1) == "x"
    rest = m.group(2)
    parts = rest.split("|", 1)
    name_with_tags = parts[0].rstrip()
    meta = parse_meta(parts[1]) if len(parts) > 1 else {}
    tags = TAG_RE.findall(name_with_tags)
    name = TAG_RE.sub("", name_with_tags)
    name = re.sub(r"\s+", " ", name).strip()
    return {
        "id": line_no,
        "name": name,
        "done": done,
        "tags": tags,
        "priority": meta.get("priority"),
        "due": meta.get("due"),
        "repeat": meta.get("repeat"),
        "created": meta.get("created"),
        "pending_delete": bool(meta.get("pending_delete", False)),
        "line": line_no,
    }


def get_all_tasks() -> list:
    if not TASKS_FILE.exists():
        return []
    tasks = []
    for i, line in enumerate(TASKS_FILE.read_text().splitlines()):
        t = parse_task_line(line, i)
        if t:
            tasks.append(t)
    return tasks


def build_task_line(name: str, done: bool, tags: List[str],
                    priority: Optional[str], due: Optional[str],
                    repeat: Optional[str],
                    pending_delete: bool = False,
                    completed: Optional[str] = None,
                    created: Optional[str] = None) -> str:
    check = "x" if done else " "
    name_part = name.strip()
    if tags:
        name_part = name_part + " " + " ".join(f"#{t}" for t in tags)
    parts = [name_part]
    if priority:
        parts.append(priority)
    if due:
        parts.append(f"due:{due}")
    if repeat:
        parts.append(f"repeat:{repeat}")
    if completed:
        parts.append(f"completed:{completed}")
    if created:
        parts.append(f"created:{created}")
    if pending_delete:
        parts.append("pending_delete:1")
    return f"- [{check}] " + " | ".join(parts)


def update_line(line_no: int, new_line: str):
    lines = TASKS_FILE.read_text().splitlines()
    lines[line_no] = new_line
    TASKS_FILE.write_text("\n".join(lines) + "\n")


def delete_line(line_no: int):
    lines = TASKS_FILE.read_text().splitlines()
    lines.pop(line_no)
    TASKS_FILE.write_text("\n".join(lines) + "\n")


def append_task(task_line: str):
    if not TASKS_FILE.exists():
        TASKS_FILE.write_text("# Tasks\n\n")
    content = TASKS_FILE.read_text()
    if not content.endswith("\n"):
        content += "\n"
    TASKS_FILE.write_text(content + task_line + "\n")


def append_archive(task_line: str):
    if not ARCHIVE.exists():
        ARCHIVE.write_text("# Archive\n\n")
    content = ARCHIVE.read_text()
    if not content.endswith("\n"):
        content += "\n"
    ARCHIVE.write_text(content + task_line + "\n")


# --- API models ---

class TaskCreate(BaseModel):
    name: str
    tags: List[str] = []
    priority: Optional[str] = None
    due: Optional[str] = None


class TaskUpdate(BaseModel):
    name: Optional[str] = None
    done: Optional[bool] = None
    tags: Optional[List[str]] = None
    priority: Optional[str] = None
    due: Optional[str] = None
    pending_delete: Optional[bool] = None


class ReorderTasks(BaseModel):
    order: List[int]


class TagCreate(BaseModel):
    name: str
    label: Optional[str] = None
    parent: Optional[str] = None


class TagUpdate(BaseModel):
    label: Optional[str] = None
    parent: Optional[str] = None


# --- Tags config ---

def load_tags_config() -> list:
    if TAGS_CONFIG.exists():
        return json.loads(TAGS_CONFIG.read_text())
    return []


def save_tags_config(config: list):
    TAGS_CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2))


def list_tags_with_discovered() -> list:
    """Return saved config + any tags found in tasks but missing from config."""
    config = load_tags_config()
    known_ids = {p["id"] for p in config}
    used = set()
    for t in get_all_tasks():
        used.update(t["tags"])
    for u in used:
        if u not in known_ids:
            config.append({"id": u, "label": u, "parent": None})
    return config


# --- API ---

@app.get("/api/tasks")
def list_tasks():
    return get_all_tasks()


@app.get("/api/tags")
def list_tags():
    return list_tags_with_discovered()


@app.post("/api/tasks")
def create_task(body: TaskCreate):
    # Allow inline #tags in name; merge with explicit tags
    inline = TAG_RE.findall(body.name)
    name = TAG_RE.sub("", body.name)
    name = re.sub(r"\s+", " ", name).strip()
    tags = list(dict.fromkeys([*body.tags, *inline]))
    created = datetime.now().isoformat(timespec="seconds")
    line = build_task_line(name, False, tags, body.priority, body.due, None,
                           created=created)
    append_task(line)
    sync_bg()
    return {"ok": True}


@app.patch("/api/tasks/{line_no}")
def update_task(line_no: int, body: TaskUpdate):
    tasks = get_all_tasks()
    task = next((t for t in tasks if t["line"] == line_no), None)
    if not task:
        raise HTTPException(404, "Task not found")

    new_name = body.name if body.name is not None else task["name"]
    new_done = body.done if body.done is not None else task["done"]
    new_tags = body.tags if body.tags is not None else task["tags"]
    new_priority = body.priority if body.priority is not None else task["priority"]
    new_due = body.due if body.due is not None else task["due"]
    new_pending = body.pending_delete if body.pending_delete is not None else task["pending_delete"]

    # If name has inline tags (from edit field), extract and merge
    if body.name is not None:
        inline = TAG_RE.findall(new_name)
        new_name = re.sub(r"\s+", " ", TAG_RE.sub("", new_name)).strip()
        if body.tags is None:
            new_tags = list(dict.fromkeys([*new_tags, *inline]))
        else:
            new_tags = list(dict.fromkeys([*new_tags, *inline]))

    completed = date.today().isoformat() if new_done and not task["done"] else None
    new_line = build_task_line(new_name, new_done, new_tags, new_priority,
                               new_due, task.get("repeat"),
                               pending_delete=new_pending, completed=completed,
                               created=task.get("created"))

    if new_done and not task["done"]:
        # Completion: move to archive
        delete_line(line_no)
        append_archive(new_line)
    else:
        update_line(line_no, new_line)

    sync_bg()
    return {"ok": True}


@app.delete("/api/tasks/{line_no}")
def delete_task(line_no: int):
    delete_line(line_no)
    sync_bg()
    return {"ok": True}


@app.put("/api/tasks/order")
def reorder_tasks(body: ReorderTasks):
    """Rewrite TASKS_FILE with task lines in the given order.
    Non-task lines (heading, blank lines) preserved at the top."""
    if not TASKS_FILE.exists():
        return {"ok": True}
    lines = TASKS_FILE.read_text().splitlines()
    first_task_idx = next((i for i, l in enumerate(lines) if TASK_RE.match(l)), len(lines))
    header = lines[:first_task_idx]
    tasks_by_line = {i: l for i, l in enumerate(lines) if TASK_RE.match(l)}
    new_tasks = []
    seen = set()
    for ln in body.order:
        if ln in tasks_by_line:
            new_tasks.append(tasks_by_line[ln])
            seen.add(ln)
    # Append any tasks not in order (safety net)
    for ln, content in tasks_by_line.items():
        if ln not in seen:
            new_tasks.append(content)
    TASKS_FILE.write_text("\n".join(header + new_tasks) + "\n")
    sync_bg()
    return {"ok": True}


@app.post("/api/tags")
def create_tag(body: TagCreate):
    name = re.sub(r"[^\w\-]", "-", body.name.strip())
    if not name:
        raise HTTPException(400, "Invalid name")
    label = body.label or body.name
    config = load_tags_config()
    if not any(p["id"] == name for p in config):
        config.append({"id": name, "label": label, "parent": body.parent})
        save_tags_config(config)
    sync_bg()
    return {"name": name}


@app.put("/api/tags")
async def reorder_tags(request: Request):
    body = await request.json()
    save_tags_config(body)
    sync_bg()
    return {"ok": True}


@app.patch("/api/tags/{name}")
def update_tag(name: str, body: TagUpdate):
    config = load_tags_config()
    for p in config:
        if p["id"] == name:
            if body.label is not None:
                p["label"] = body.label
            if body.parent is not None:
                p["parent"] = body.parent or None
            break
    save_tags_config(config)
    sync_bg()
    return {"ok": True}


@app.delete("/api/tags/{name}")
def delete_tag(name: str):
    # Remove from config
    config = load_tags_config()
    config = [p for p in config if p["id"] != name]
    # Re-parent any children of the deleted tag to None
    for p in config:
        if p.get("parent") == name:
            p["parent"] = None
    save_tags_config(config)
    # Strip the tag from all task lines
    if TASKS_FILE.exists():
        lines = TASKS_FILE.read_text().splitlines()
        new_lines = []
        for line in lines:
            t = parse_task_line(line, 0)
            if not t:
                new_lines.append(line)
                continue
            if name in t["tags"]:
                new_tags = [tag for tag in t["tags"] if tag != name]
                rebuilt = build_task_line(
                    t["name"], t["done"], new_tags,
                    t["priority"], t["due"], t["repeat"],
                    pending_delete=t["pending_delete"],
                    created=t.get("created"),
                )
                new_lines.append(rebuilt)
            else:
                new_lines.append(line)
        TASKS_FILE.write_text("\n".join(new_lines) + "\n")
    sync_bg()
    return {"ok": True}


@app.get("/api/tunnel-url")
def get_tunnel_url():
    try:
        log = Path("/tmp/neo-todo-tunnel.log").read_text()
        m = re.search(r'https://[\w-]+\.trycloudflare\.com', log)
        return {"url": m.group(0) if m else None}
    except Exception:
        return {"url": None}


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    resp = FileResponse("static/index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp
