"""AI Office: run a crew and watch it work in a pixel-art office.

    .venv/bin/python apps/ai_office/server.py   ->  http://localhost:8765
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

APP_DIR = Path(__file__).resolve().parent
CREW_DIR = APP_DIR.parent.parent / "examples" / "research_crew"
RUNS_DIR = APP_DIR / "runs"
SAMPLES_DIR = APP_DIR / "samples"
MAX_REPLAY_GAP = 2.5  # seconds; live runs have multi-minute gaps between events

sys.path.insert(0, str(CREW_DIR))
load_dotenv(CREW_DIR / ".env")
load_dotenv(APP_DIR / ".env")

from bridge import OfficeEventListener  # noqa: E402
from crew import ResearchCrew  # noqa: E402


class Office:
    """Holds the connected browsers and the events of the current session."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.history: list[dict[str, Any]] = []
        self.busy = False
        self.listener = OfficeEventListener()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.record_file: Path | None = None

    async def broadcast_forever(self) -> None:
        # A single consumer keeps events in emission order for every client.
        while True:
            event = await self.queue.get()
            if event["kind"] == "reset":
                self.history.clear()
            self.history.append(event)
            if self.record_file is not None:
                with self.record_file.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(event, ensure_ascii=False) + "\n")
            message = json.dumps(event, ensure_ascii=False)
            for ws in list(self.clients):
                try:
                    await ws.send_text(message)
                except Exception:
                    self.clients.discard(ws)

    async def publish(self, event: dict[str, Any]) -> None:
        self.queue.put_nowait(event)

    def publish_threadsafe(self, event: dict[str, Any]) -> None:
        # crewAI emits events from worker threads.
        assert self.loop is not None
        self.loop.call_soon_threadsafe(self.queue.put_nowait, event)

    async def reset(self, mode: str) -> None:
        await self.publish({"kind": "reset", "mode": mode, "t": time.time()})

    async def run_crew(self, topic: str) -> None:
        run_dir = RUNS_DIR / datetime.now().strftime("%Y%m%d-%H%M%S")
        run_dir.mkdir(parents=True)
        self.record_file = run_dir / "events.jsonl"
        await self.reset("live")
        try:
            research_crew = ResearchCrew()
            crew = research_crew.crew()
            keys = list(research_crew.agents_config)
            await self.publish(
                {
                    "kind": "roster",
                    "t": time.time(),
                    "topic": topic,
                    "agents": [
                        {"id": str(a.id), "key": key, "role": a.role}
                        for a, key in zip(crew.agents, keys)
                    ],
                    "tasks": [
                        {"id": str(t.id), "name": t.name, "agent": str(t.agent.id)}
                        for t in crew.tasks
                    ],
                }
            )
            self.listener.sink = self.publish_threadsafe
            inputs = {"topic": topic, "current_year": str(datetime.now().year)}
            result = await asyncio.to_thread(crew.kickoff, inputs=inputs)
            (run_dir / "report.md").write_text(result.raw, encoding="utf-8")
        except Exception as e:  # surfaced in the office instead of killing the server
            await self.publish({"kind": "run_failed", "t": time.time(), "error": str(e)})
        finally:
            self.listener.sink = None
            # Let events already queued from crew threads land in this run's file.
            await asyncio.sleep(0.5)
            self.record_file = None
            self.busy = False

    async def replay(self, path: Path, speed: float) -> None:
        events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
        await self.reset("replay")
        try:
            previous = None
            for event in events:
                if event["kind"] == "reset":
                    continue
                if previous is not None:
                    gap = min(event["t"] - previous, MAX_REPLAY_GAP) / speed
                    await asyncio.sleep(max(gap, 0))
                previous = event["t"]
                await self.publish({**event, "t": time.time()})
        finally:
            self.busy = False


office = Office()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    office.loop = asyncio.get_running_loop()
    broadcaster = asyncio.create_task(office.broadcast_forever())
    yield
    broadcaster.cancel()


app = FastAPI(title="AI Office", lifespan=lifespan)


class RunRequest(BaseModel):
    topic: str


class ReplayRequest(BaseModel):
    name: str
    speed: float = 1.0


def _recordings() -> dict[str, Path]:
    found = {f"sample/{p.stem}": p for p in sorted(SAMPLES_DIR.glob("*.jsonl"))}
    for p in sorted(RUNS_DIR.glob("*/events.jsonl"), reverse=True):
        found[f"run/{p.parent.name}"] = p
    return found


def _claim() -> None:
    if office.busy:
        raise HTTPException(409, "이미 실행 중입니다.")
    office.busy = True


@app.get("/api/status")
async def status() -> dict[str, Any]:
    return {
        "busy": office.busy,
        "has_api_key": bool(os.getenv("ANTHROPIC_API_KEY")),
        "recordings": list(_recordings()),
    }


@app.post("/api/run")
async def run(req: RunRequest) -> dict[str, str]:
    topic = req.topic.strip()
    if not topic:
        raise HTTPException(400, "주제를 입력하세요.")
    _claim()
    asyncio.create_task(office.run_crew(topic))
    return {"status": "started"}


@app.post("/api/replay")
async def replay(req: ReplayRequest) -> dict[str, str]:
    path = _recordings().get(req.name)
    if path is None:
        raise HTTPException(404, "녹화를 찾을 수 없습니다.")
    _claim()
    asyncio.create_task(office.replay(path, max(req.speed, 0.1)))
    return {"status": "started"}


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    await websocket.send_text(json.dumps({"kind": "history", "events": office.history}, ensure_ascii=False))
    office.clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        office.clients.discard(websocket)


app.mount("/", StaticFiles(directory=APP_DIR / "static", html=True), name="static")

if __name__ == "__main__":
    # The crew writes its output_file relative to the working directory.
    os.chdir(APP_DIR)
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8765")))
