"""A business's team: one manager who delegates and the members who do the work.

Each business (see ``store.py``) keeps its own team; ``team.default.json`` is the
template for new ones.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

APP_DIR = Path(__file__).resolve().parent
DEFAULT_TEAM_FILE = APP_DIR / "team.default.json"

# Each member adds a delegate-and-review round for the manager (time and tokens).
MAX_MEMBERS = 20
MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5")
TOOLS = ("web_search",)
# Kickoff only supplies these ({topic} is the instruction text); any other {name}
# makes crewAI fail at run time.
PLACEHOLDERS = {"topic", "current_year"}
_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_\-]*)\}")

Color = Field(pattern=r"^#[0-9a-fA-F]{6}$")
Text = Field(min_length=1, max_length=2000)
Short = Field(min_length=1, max_length=40)


class Look(BaseModel):
    hair: str = Color
    skin: str = Color
    shirt: str = Color
    pants: str = Color
    long_hair: bool = False


class Person(BaseModel):
    name: str = Short
    title: str = Short
    role: str = Field(min_length=1, max_length=200)
    goal: str = Text
    backstory: str = Text
    model: Literal[MODELS] = MODELS[0]  # type: ignore[valid-type]
    look: Look

    @field_validator("name", "team", "role", "goal", "backstory", "task", "expected_output", check_fields=False)
    @classmethod
    def _known_placeholders(cls, value: str) -> str:
        unknown = set(_PLACEHOLDER.findall(value)) - PLACEHOLDERS
        if unknown:
            names = ", ".join(f"{{{n}}}" for n in sorted(unknown))
            raise ValueError(f"사용할 수 없는 변수: {names} ({{topic}}, {{current_year}}만 가능)")
        return value


class Member(Person):
    key: str = Field(pattern=r"^[a-z0-9_]{1,32}$")
    team: str = Short
    task_name: str = Short
    task: str = Text
    expected_output: str = Text
    tools: list[Literal[TOOLS]] = []  # type: ignore[valid-type]


class Team(BaseModel):
    manager: Person
    members: list[Member] = Field(min_length=1, max_length=MAX_MEMBERS)

    @field_validator("members")
    @classmethod
    def _unique_keys(cls, members: list[Member]) -> list[Member]:
        keys = [m.key for m in members]
        if len(keys) != len(set(keys)):
            raise ValueError("팀원 key가 중복됩니다.")
        return members

    @model_validator(mode="after")
    def _unique_roles(self) -> Team:
        # The manager delegates by naming a coworker's role, so roles must tell people apart.
        seen: dict[str, str] = {}
        for person in [self.manager, *self.members]:
            role = " ".join(person.role.split()).lower()
            if role in seen:
                raise ValueError(
                    f"{seen[role]}와 {person.name}의 역할(role)이 '{person.role}'로 같습니다. "
                    "팀장은 역할로 사람을 구분해 일을 맡기므로 서로 달라야 합니다."
                )
            seen[role] = person.name
        return self


def default_team() -> Team:
    return Team.model_validate_json(DEFAULT_TEAM_FILE.read_text(encoding="utf-8"))
