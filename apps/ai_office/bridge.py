"""Turns crewAI events into small JSON "office events" for the browser."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from crewai.events import BaseEventListener
from crewai.events.event_bus import CrewAIEventsBus
from crewai.events.types.agent_events import (
    AgentExecutionCompletedEvent,
    AgentExecutionErrorEvent,
    AgentExecutionStartedEvent,
)
from crewai.events.types.crew_events import (
    CrewKickoffCompletedEvent,
    CrewKickoffFailedEvent,
    CrewKickoffStartedEvent,
)
from crewai.events.types.llm_events import LLMCallStartedEvent
from crewai.events.types.task_events import (
    TaskCompletedEvent,
    TaskFailedEvent,
    TaskStartedEvent,
)
from crewai.events.types.tool_usage_events import (
    ToolUsageErrorEvent,
    ToolUsageFinishedEvent,
    ToolUsageStartedEvent,
)

Sink = Callable[[dict[str, Any]], None]

PREVIEW_CHARS = 600


def _preview(value: Any, limit: int = PREVIEW_CHARS) -> str:
    text = getattr(value, "raw", None) or str(value or "")
    return text if len(text) <= limit else text[:limit] + "…"


def _agent_id(event: Any) -> str | None:
    for attr in ("agent", "from_agent"):
        agent = getattr(event, attr, None)
        if agent is not None and getattr(agent, "id", None):
            return str(agent.id)
    return str(event.agent_id) if getattr(event, "agent_id", None) else None


def _task_id(event: Any) -> str | None:
    for attr in ("task", "from_task"):
        task = getattr(event, attr, None)
        if task is not None and getattr(task, "id", None):
            return str(task.id)
    return str(event.task_id) if getattr(event, "task_id", None) else None


class OfficeEventListener(BaseEventListener):
    """Forwards crew progress to ``sink`` while a crew run is active.

    The listener is registered on the global event bus once; ``sink`` is swapped
    per run so events from unrelated crews are ignored when no run is active.
    """

    def __init__(self) -> None:
        self.sink: Sink | None = None
        super().__init__()

    def _emit(self, kind: str, **data: Any) -> None:
        if self.sink is not None:
            self.sink({"kind": kind, "t": time.time(), **data})

    def setup_listeners(self, crewai_event_bus: CrewAIEventsBus) -> None:
        @crewai_event_bus.on(CrewKickoffStartedEvent)
        def _(source: Any, event: CrewKickoffStartedEvent) -> None:
            self._emit("run_started", inputs=event.inputs or {})

        @crewai_event_bus.on(TaskStartedEvent)
        def _(source: Any, event: TaskStartedEvent) -> None:
            task = event.task
            self._emit(
                "task_started",
                task=_task_id(event),
                name=getattr(task, "name", None),
                agent=_agent_id(task) if task is not None else None,
            )

        @crewai_event_bus.on(AgentExecutionStartedEvent)
        def _(source: Any, event: AgentExecutionStartedEvent) -> None:
            self._emit("agent_started", agent=_agent_id(event), task=_task_id(event))

        @crewai_event_bus.on(LLMCallStartedEvent)
        def _(source: Any, event: LLMCallStartedEvent) -> None:
            self._emit("thinking", agent=_agent_id(event))

        @crewai_event_bus.on(ToolUsageStartedEvent)
        def _(source: Any, event: ToolUsageStartedEvent) -> None:
            args = event.tool_args if isinstance(event.tool_args, dict) else {}
            self._emit(
                "tool_started",
                agent=_agent_id(event),
                tool=event.tool_name,
                args=_preview(event.tool_args, 200),
                # Delegation tools: who gets the work, and what they are asked.
                coworker=args.get("coworker"),
                request=_preview(args.get("task") or args.get("question"), 300) or None,
            )

        @crewai_event_bus.on(ToolUsageFinishedEvent)
        def _(source: Any, event: ToolUsageFinishedEvent) -> None:
            args = event.tool_args if isinstance(event.tool_args, dict) else {}
            delegated = bool(args.get("coworker")) and bool(args.get("task"))
            self._emit(
                "tool_finished",
                agent=_agent_id(event),
                tool=event.tool_name,
                output=_preview(event.output),
                # A finished delegation in full, so an interrupted instruction can resume from it.
                coworker=args.get("coworker") if delegated else None,
                request=args.get("task") if delegated else None,
                result=(getattr(event.output, "raw", None) or str(event.output or "")) if delegated else None,
            )

        @crewai_event_bus.on(ToolUsageErrorEvent)
        def _(source: Any, event: ToolUsageErrorEvent) -> None:
            self._emit(
                "tool_error",
                agent=_agent_id(event),
                tool=event.tool_name,
                error=_preview(event.error, 300),
            )

        @crewai_event_bus.on(AgentExecutionCompletedEvent)
        def _(source: Any, event: AgentExecutionCompletedEvent) -> None:
            self._emit("agent_completed", agent=_agent_id(event))

        @crewai_event_bus.on(AgentExecutionErrorEvent)
        def _(source: Any, event: AgentExecutionErrorEvent) -> None:
            self._emit("agent_error", agent=_agent_id(event), error=_preview(event.error, 300))

        @crewai_event_bus.on(TaskCompletedEvent)
        def _(source: Any, event: TaskCompletedEvent) -> None:
            self._emit("task_completed", task=_task_id(event), output=_preview(event.output))

        @crewai_event_bus.on(TaskFailedEvent)
        def _(source: Any, event: TaskFailedEvent) -> None:
            self._emit("task_failed", task=_task_id(event), error=_preview(event.error, 300))

        @crewai_event_bus.on(CrewKickoffCompletedEvent)
        def _(source: Any, event: CrewKickoffCompletedEvent) -> None:
            self._emit(
                "run_completed",
                report=getattr(event.output, "raw", str(event.output)),
                total_tokens=event.total_tokens,
            )

        @crewai_event_bus.on(CrewKickoffFailedEvent)
        def _(source: Any, event: CrewKickoffFailedEvent) -> None:
            self._emit("run_failed", error=_preview(event.error, 500))
