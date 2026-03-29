from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pathlib import Path
import re
from datetime import date

TASKS_DIR = Path("/Users/neo/tasks")
INBOX = TASKS_DIR / "inbox.md"
ARCHIVE = TASKS_DIR / "archive.md"
PROJECTS_DIR = TASKS_DIR / "projects"

app = FastAPI()


# --- Task parsing ---

TASK_RE = re.compile(r"^- \[([ x])\] (.+)$")
META_RE = re.compile(r"\|(.*)")


def parse_meta(meta_str: str) -> dict:
    meta = {"priority": None, "due": None, "repeat": None}
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


def parse_tasks_from_file(filepath: Path, project: str) -> list[dict]:
    tasks = []
    if not filepath.exists():
        return tasks
    lines = filepath.read_text().splitlines()
    for i, line in enumerate(lines):
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


def get_all_tasks() -> list[dict]:
    tasks = parse_tasks_from_file(INBOX, "inbox")
    for pfile in sorted(PROJECTS_DIR.glob("*.md")):
        project = pfile.stem
        tasks.extend(parse_tasks_from_file(pfile, project))
    return tasks


def build_task_line(name: str, done: bool, priority: str | None, due: str | None, repeat: str | None, completed: str | None = None) -> str:
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
    priority: str | None = None
    due: str | None = None


class TaskUpdate(BaseModel):
    name: str | None = None
    done: bool | None = None
    priority: str | None = None
    due: str | None = None
    project: str | None = None


@app.get("/api/tasks")
def list_tasks():
    return get_all_tasks()


@app.get("/api/projects")
def list_projects():
    projects = ["inbox"]
    for pfile in sorted(PROJECTS_DIR.glob("*.md")):
        projects.append(pfile.stem)
    return projects


@app.post("/api/tasks")
def create_task(body: TaskCreate):
    fp = filepath_for_project(body.project)
    line = build_task_line(body.name, False, body.priority, body.due, None)
    append_task_to_file(fp, line)
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

    new_line = build_task_line(new_name, new_done, new_priority, new_due, task.get("repeat"), completed)

    if body.project and body.project != project:
        # Move to different project
        delete_line_in_file(fp, line_no)
        target_fp = filepath_for_project(body.project)
        append_task_to_file(target_fp, new_line)
    else:
        if new_done and not task["done"]:
            # Archive completed task
            delete_line_in_file(fp, line_no)
            append_task_to_file(ARCHIVE, new_line)
        else:
            update_line_in_file(fp, line_no, new_line)

    return {"ok": True}


@app.delete("/api/tasks/{project}/{line_no}")
def delete_task(project: str, line_no: int):
    fp = filepath_for_project(project)
    delete_line_in_file(fp, line_no)
    return {"ok": True}


# Static files
app.mount("/", StaticFiles(directory="static", html=True), name="static")
