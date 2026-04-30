from __future__ import annotations
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from pathlib import Path
from typing import Optional
import re
import json
import subprocess
import threading
from datetime import date

TASKS_DIR = Path("/Users/neo/tasks")
INBOX = TASKS_DIR / "inbox.md"
ARCHIVE = TASKS_DIR / "archive.md"
PROJECTS_DIR = TASKS_DIR / "projects"
PROJECTS_CONFIG = TASKS_DIR / "projects.json"

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


# --- Task parsing ---

TASK_RE = re.compile(r"^- \[([ x])\] (.+)$")


def parse_meta(meta_str: str) -> dict:
    meta: dict = {}
    for part in meta_str.split("|"):
        part = part.strip()
        if re.match(r"P[1-4]$", part):
            meta["priority"] = part
        elif part.startswith("due:"):
            meta["due"] = part[4:]
        elif part.startswith("repeat:"):
            meta["repeat"] = part[7:]
        elif part.startswith("completed:"):
            meta["completed"] = part[10:]
    return meta


def parse_tasks_from_file(filepath: Path, project: str) -> list:
    tasks = []
    if not filepath.exists():
        return tasks
    for i, line in enumerate(filepath.read_text().splitlines()):
        m = TASK_RE.match(line)
        if not m:
            continue
        done = m.group(1) == "x"
        rest = m.group(2)
        parts = rest.split("|", 1)
        name = parts[0].strip()
        meta = parse_meta(parts[1]) if len(parts) > 1 else {}
        tasks.append({
            "id": f"{project}:{i}",
            "name": name,
            "done": done,
            "project": project,
            "priority": meta.get("priority"),
            "due": meta.get("due"),
            "repeat": meta.get("repeat"),
            "line": i,
        })
    return tasks


def get_all_tasks() -> list:
    tasks = parse_tasks_from_file(INBOX, "inbox")
    for pfile in sorted(PROJECTS_DIR.glob("*.md")):
        tasks.extend(parse_tasks_from_file(pfile, pfile.stem))
    return tasks


def build_task_line(name: str, done: bool, priority: Optional[str],
                    due: Optional[str], repeat: Optional[str],
                    completed: Optional[str] = None) -> str:
    check = "x" if done else " "
    parts = [name]
    if priority:
        parts.append(priority)
    if due:
        parts.append(f"due:{due}")
    if repeat:
        parts.append(f"repeat:{repeat}")
    if completed:
        parts.append(f"completed:{completed}")
    return f"- [{check}] " + " | ".join(parts)


def filepath_for_project(project: str) -> Path:
    if project == "inbox":
        return INBOX
    return PROJECTS_DIR / f"{project}.md"


def update_line_in_file(filepath: Path, line_no: int, new_line: str):
    lines = filepath.read_text().splitlines()
    lines[line_no] = new_line
    filepath.write_text("\n".join(lines) + "\n")


def delete_line_in_file(filepath: Path, line_no: int):
    lines = filepath.read_text().splitlines()
    lines.pop(line_no)
    filepath.write_text("\n".join(lines) + "\n")


def append_task_to_file(filepath: Path, task_line: str):
    if not filepath.exists():
        filepath.write_text(f"# {filepath.stem.capitalize()}\n\n")
    content = filepath.read_text()
    if not content.endswith("\n"):
        content += "\n"
    filepath.write_text(content + task_line + "\n")


# --- API ---

class TaskCreate(BaseModel):
    name: str
    project: str = "inbox"
    priority: Optional[str] = None
    due: Optional[str] = None


class TaskUpdate(BaseModel):
    name: Optional[str] = None
    done: Optional[bool] = None
    priority: Optional[str] = None
    due: Optional[str] = None
    project: Optional[str] = None


class ProjectCreate(BaseModel):
    name: str
    label: Optional[str] = None
    parent: Optional[str] = None


class ProjectUpdate(BaseModel):
    label: Optional[str] = None
    parent: Optional[str] = None


def load_projects_config() -> list:
    if PROJECTS_CONFIG.exists():
        return json.loads(PROJECTS_CONFIG.read_text())
    # fallback: build from files
    config = [{"id": "inbox", "label": "Inbox", "parent": None}]
    for pfile in sorted(PROJECTS_DIR.glob("*.md")):
        config.append({"id": pfile.stem, "label": pfile.stem, "parent": None})
    return config


def save_projects_config(config: list):
    PROJECTS_CONFIG.write_text(json.dumps(config, ensure_ascii=False, indent=2))


@app.get("/api/tasks")
def list_tasks():
    return get_all_tasks()


@app.get("/api/projects")
def list_projects():
    return load_projects_config()


@app.post("/api/tasks")
def create_task(body: TaskCreate):
    fp = filepath_for_project(body.project)
    line = build_task_line(body.name, False, body.priority, body.due, None)
    append_task_to_file(fp, line)
    sync_bg()
    return {"ok": True}


@app.patch("/api/tasks/{project}/{line_no}")
def update_task(project: str, line_no: int, body: TaskUpdate):
    fp = filepath_for_project(project)
    tasks = parse_tasks_from_file(fp, project)
    task = next((t for t in tasks if t["line"] == line_no), None)
    if not task:
        raise HTTPException(404, "Task not found")

    new_name = body.name if body.name is not None else task["name"]
    new_done = body.done if body.done is not None else task["done"]
    new_priority = body.priority if body.priority is not None else task["priority"]
    new_due = body.due if body.due is not None else task["due"]
    completed = date.today().isoformat() if new_done and not task["done"] else None

    new_line = build_task_line(new_name, new_done, new_priority, new_due,
                               task.get("repeat"), completed)

    if body.project and body.project != project:
        delete_line_in_file(fp, line_no)
        target_fp = filepath_for_project(body.project)
        append_task_to_file(target_fp, new_line)
    elif new_done and not task["done"]:
        delete_line_in_file(fp, line_no)
        append_task_to_file(ARCHIVE, new_line)
    else:
        update_line_in_file(fp, line_no, new_line)

    sync_bg()
    return {"ok": True}


@app.delete("/api/tasks/{project}/{line_no}")
def delete_task(project: str, line_no: int):
    fp = filepath_for_project(project)
    delete_line_in_file(fp, line_no)
    sync_bg()
    return {"ok": True}


@app.post("/api/projects")
def create_project(body: ProjectCreate):
    name = re.sub(r"[^\w\-]", "-", body.name.strip())
    if not name:
        raise HTTPException(400, "Invalid name")
    label = body.label or body.name
    fp = PROJECTS_DIR / f"{name}.md"
    if not fp.exists():
        fp.write_text(f"# {label}\n\n")
    config = load_projects_config()
    if not any(p["id"] == name for p in config):
        config.append({"id": name, "label": label, "parent": body.parent})
        save_projects_config(config)
    sync_bg()
    return {"name": name}


@app.put("/api/projects")
async def reorder_projects(request: Request):
    body = await request.json()
    save_projects_config(body)
    sync_bg()
    return {"ok": True}


@app.patch("/api/projects/{name}")
def update_project(name: str, body: ProjectUpdate):
    config = load_projects_config()
    for p in config:
        if p["id"] == name:
            if body.label is not None:
                p["label"] = body.label
            if body.parent is not None:
                p["parent"] = body.parent or None
            break
    save_projects_config(config)
    return {"ok": True}


@app.delete("/api/projects/{name}")
def delete_project(name: str):
    if name == "inbox":
        raise HTTPException(400, "Cannot delete inbox")
    fp = PROJECTS_DIR / f"{name}.md"
    tasks = parse_tasks_from_file(fp, name)
    # Move remaining open tasks to inbox
    for t in tasks:
        if not t["done"]:
            line = build_task_line(t["name"], False, t.get("priority"),
                                   t.get("due"), t.get("repeat"))
            append_task_to_file(INBOX, line)
    if fp.exists():
        fp.unlink()
    config = load_projects_config()
    config = [p for p in config if p["id"] != name]
    save_projects_config(config)
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


# Static
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    resp = FileResponse("static/index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp
