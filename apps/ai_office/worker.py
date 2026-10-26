"""Carries out one instruction in its own process so the server can stop it at any moment.

    python worker.py <run_dir>      (run_dir/order.json: the instruction and the team)

Office events are written to stdout as JSON lines; everything else the crew
prints (verbose logs) is redirected to stderr.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

# Claim the real stdout for events before crewAI sets up its console.
_events = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
_lock = threading.Lock()
_ended = threading.Event()  # set once run_completed / run_failed went out

APP_DIR = Path(__file__).resolve().parent
CREW_DIR = APP_DIR.parent.parent / "examples" / "research_crew"
sys.path.insert(0, str(CREW_DIR))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(CREW_DIR / ".env")
load_dotenv(APP_DIR / ".env")

from crewai import LLM, Agent, Crew, Process, Task  # noqa: E402
from crewai.events import crewai_event_bus  # noqa: E402
from tools import ClaudeWebSearchTool  # noqa: E402

from bridge import OfficeEventListener  # noqa: E402
from team import Person, Team  # noqa: E402

TOOL_FACTORIES = {"web_search": ClaudeWebSearchTool}

# {topic} is filled with the instruction at kickoff (never re-parsed, so braces in it are safe).
ORDER_DESCRIPTION = """대표(CEO)의 업무 지시:
{topic}

팀장으로서 이 지시를 완수하라. 지시를 이루는 데 필요한 일을 나누고, 팀 구성과 각자의
담당 분야를 보고 알맞은 팀원에게 하나씩 맡겨라(Delegate work to coworker). 맡길 때는
무엇을, 왜, 어떤 형식으로 받고 싶은지 구체적으로 적어라. 받은 결과를 검토해 부족하면
다시 요청하라. 직접 작업하지 말고 반드시 팀원에게 맡겨라. 현재 연도는 {current_year}년이다."""
ORDER_OUTPUT = (
    "지시를 완수한 최종 결과물. 팀원들의 결과를 종합한 한국어 마크다운 문서로, "
    "맨 끝에 '## 작업 노트' 섹션을 두고 누가 무엇을 했는지 3~5개 불릿으로 정리한다. "
    "코드 블록으로 감싸지 않는다."
)


def emit(event: dict[str, Any]) -> None:
    # crewAI emits events from several threads.
    with _lock:
        _events.write(json.dumps(event, ensure_ascii=False) + "\n")
    if event["kind"] in ("run_completed", "run_failed"):
        _ended.set()


def _agent(person: Person, **kwargs: Any) -> Agent:
    kwargs.setdefault("backstory", person.backstory)
    return Agent(
        role=person.role,
        goal=person.goal,
        llm=LLM(model=f"anthropic/{person.model}"),
        inject_date=True,
        verbose=True,
        **kwargs,
    )


def _org_chart(team: Team) -> str:
    teams: dict[str, list[str]] = {}
    for m in team.members:
        teams.setdefault(m.team, []).append(f"{m.name}({m.role}) - {m.task_name}: {m.task}")
    return "\n".join(f"- {name}\n  " + "\n  ".join(people) for name, people in teams.items())


RESUME_NOTE = """이 지시는 중간에 중단된 실행을 이어서 하는 것이다. 그때 팀원들이 이미 끝낸 일과
결과가 아래에 있다. 같은 일을 다시 맡기지 말고 이 결과를 그대로 활용하라. 아직 안 된 일만
맡기고, 결과가 잘려 있거나 부족할 때만 보완을 요청하라."""


def _no_braces(text: str) -> str:
    # Braces would read as crewAI placeholders.
    return text.replace("{", "(").replace("}", ")")


def _finished_work_text(work: list[dict[str, Any]]) -> str:
    blocks = []
    for item in work:
        who = item.get("coworker") or "팀원"
        head = f"### {who}에게 맡긴 일" + (f": {item['task']}" if item.get("task") else "")
        cut = "\n(기록에 앞부분만 남아 있음)" if item.get("partial") else ""
        blocks.append(f"{head}\n결과:\n{item['result']}{cut}")
    return "\n\n".join(blocks)


def build_crew(
    team: Team, goal: str = "", finished_work: list[dict[str, Any]] | None = None
) -> tuple[Crew, Agent, list[Agent]]:
    """One task (the instruction) run by the manager, who splits it and delegates to members."""
    # Both sides learn the org chart and each member's specialty from their backstory.
    manager = _agent(
        team.manager,
        backstory=f"{team.manager.backstory}\n\n팀 구성과 담당 분야:\n{_org_chart(team)}",
        allow_delegation=True,
    )
    members = [
        _agent(
            m,
            backstory=(
                f"{m.backstory}\n\n소속: {m.team}\n담당 분야: {m.task_name}\n"
                f"하는 일: {m.task}\n결과물 형식: {m.expected_output}"
            ),
            tools=[TOOL_FACTORIES[name]() for name in m.tools],
            allow_delegation=False,
        )
        for m in team.members
    ]
    description = ORDER_DESCRIPTION
    if goal:
        description += f"\n\n이 사업의 목표:\n{_no_braces(goal)}\n\n지시를 이 사업의 목표에 맞게 해석하고 수행하라."
    if finished_work:
        description += f"\n\n{RESUME_NOTE}\n\n{_no_braces(_finished_work_text(finished_work))}"
    task = Task(name="order", description=description, expected_output=ORDER_OUTPUT)
    crew = Crew(
        agents=members,
        tasks=[task],
        process=Process.hierarchical,
        manager_agent=manager,
        verbose=True,
    )
    return crew, manager, members


def _person(person: Person, agent: Agent, inputs: dict[str, str]) -> dict[str, Any]:
    role = person.role
    for name, value in inputs.items():
        role = role.replace(f"{{{name}}}", value)
    return {
        "id": str(agent.id),
        "name": person.name,
        "title": person.title,
        "role": role,  # interpolated, to match the coworker named in delegations
        "look": person.look.model_dump(),
    }


def main(run_dir: Path) -> None:
    listener = OfficeEventListener()
    spec = json.loads((run_dir / "order.json").read_text(encoding="utf-8"))
    instruction = spec["order"]["instruction"]
    inputs = {"topic": instruction, "current_year": str(datetime.now().year)}
    try:
        team = Team.model_validate(spec["team"])
        crew, manager, members = build_crew(
            team, spec["project"].get("goal", ""), spec.get("finished_work")
        )
        emit(
            {
                "kind": "roster",
                "t": time.time(),
                "topic": instruction,
                "project": spec["project"],
                "manager": _person(team.manager, manager, inputs),
                "agents": [
                    {**_person(m, agent, inputs), "key": m.key, "team": m.team}
                    for m, agent in zip(team.members, members)
                ],
                "tasks": [{"id": str(crew.tasks[0].id), "name": "order", "label": "업무 지시", "agent": None}],
            }
        )
        listener.sink = emit
        result = crew.kickoff(inputs=inputs)
        # Handlers run on a thread pool; let the last events reach the sink.
        crewai_event_bus.flush()
        if not _ended.is_set():
            emit(
                {
                    "kind": "run_completed",
                    "t": time.time(),
                    "report": result.raw,
                    "total_tokens": result.token_usage.total_tokens,
                }
            )
    except Exception as e:  # surfaced in the office instead of a bare exit code
        emit({"kind": "run_failed", "t": time.time(), "error": str(e)})
    finally:
        listener.sink = None


if __name__ == "__main__":
    os.chdir(APP_DIR)
    main(Path(sys.argv[1]))
