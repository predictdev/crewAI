"""Businesses (each with its own team) and the instructions given to them.

Everything lives under ``data/`` (gitignored) as small JSON files:

    data/projects/<id>.json   one business: name and team
    data/orders.json          every instruction, oldest first
"""

from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from team import Team, default_team

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"
ORDERS_FILE = DATA_DIR / "orders.json"
LEGACY_TEAM_FILE = APP_DIR / "team.json"  # the single team saved before businesses existed

OrderStatus = Literal["queued", "running", "done", "failed", "stopped", "cancelled"]


class Project(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_-]{1,40}$")
    name: str = Field(min_length=1, max_length=40)
    team: Team
    created: float = Field(default_factory=time.time)


class Order(BaseModel):
    id: str
    project_id: str
    instruction: str = Field(min_length=1, max_length=4000)
    status: OrderStatus = "queued"
    created: float = Field(default_factory=time.time)
    started: float | None = None
    ended: float | None = None
    run: str | None = None  # runs/<run> holds its recording and report
    tokens: int | None = None
    error: str | None = None


def new_id() -> str:
    return f"{int(time.time()):x}{secrets.token_hex(2)}"


# ---------- projects ----------


def _project_path(project_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9_-]{1,40}", project_id):
        raise KeyError(project_id)
    return PROJECTS_DIR / f"{project_id}.json"


def save_project(project: Project) -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    _project_path(project.id).write_text(project.model_dump_json(indent=2), encoding="utf-8")


def get_project(project_id: str) -> Project:
    _ensure_default()
    path = _project_path(project_id)
    if not path.exists():
        raise KeyError(project_id)
    return Project.model_validate_json(path.read_text(encoding="utf-8"))


def list_projects() -> list[Project]:
    _ensure_default()
    projects = [Project.model_validate_json(p.read_text(encoding="utf-8")) for p in PROJECTS_DIR.glob("*.json")]
    return sorted(projects, key=lambda p: p.created)


def delete_project(project_id: str) -> None:
    _project_path(project_id).unlink(missing_ok=True)


def create_project(name: str, team: Team | None = None) -> Project:
    project = Project(id=new_id(), name=name, team=team or default_team())
    save_project(project)
    return project


def _ensure_default() -> None:
    """First start: one business, carrying over the team saved before businesses existed."""
    if PROJECTS_DIR.exists() and any(PROJECTS_DIR.glob("*.json")):
        return
    team = default_team()
    if LEGACY_TEAM_FILE.exists():
        raw = json.loads(LEGACY_TEAM_FILE.read_text(encoding="utf-8"))
        # {topic} is now the whole instruction, too long to sit inside a role name, and
        # roles must be unique (the manager delegates by role): number the repeats.
        seen: dict[str, int] = {}
        for person in [raw["manager"], *raw["members"]]:
            role = person["role"].replace("{topic}", "").strip() or person["title"]
            seen[role] = seen.get(role, 0) + 1
            person["role"] = role if seen[role] == 1 else f"{role} {seen[role]}"
        team = Team.model_validate(raw)
    save_project(Project(id="default", name="기본 사업", team=team))


# ---------- orders ----------


def load_orders() -> list[Order]:
    if not ORDERS_FILE.exists():
        return []
    return [Order.model_validate(o) for o in json.loads(ORDERS_FILE.read_text(encoding="utf-8"))]


def save_orders(orders: list[Order]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = "[\n" + ",\n".join(o.model_dump_json() for o in orders) + "\n]\n"
    ORDERS_FILE.write_text(payload, encoding="utf-8")
