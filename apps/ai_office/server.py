"""AI Office: give businesses instructions and watch their teams work in a pixel-art office.

    .venv/bin/python apps/ai_office/server.py   ->  http://localhost:8765

Instructions wait in one queue and run one at a time, each in its own worker process.
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
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import store
from store import Order, Project
from team import MAX_MEMBERS, MODELS, TOOLS, Team, default_team

APP_DIR = Path(__file__).resolve().parent
CREW_DIR = APP_DIR.parent.parent / "examples" / "research_crew"
RUNS_DIR = APP_DIR / "runs"
SAMPLES_DIR = APP_DIR / "samples"
MAX_REPLAY_GAP = 2.5  # seconds; live runs have multi-minute gaps between events
STOP_GRACE = 3.0  # seconds to wait after SIGTERM before SIGKILL

load_dotenv(CREW_DIR / ".env")
load_dotenv(APP_DIR / ".env")


class Office:
    """Connected browsers, the events of the current run, and the instruction queue."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.history: list[dict[str, Any]] = []
        self.busy = False
        self.job: asyncio.Task[None] | None = None  # a replay
        self.proc: asyncio.subprocess.Process | None = None  # a running instruction
        self.current: Order | None = None
        self.stopping = False
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.record_file: Path | None = None
        self.wake = asyncio.Event()
        self.orders = store.load_orders()
        for order in self.orders:
            if order.status == "running":  # the server stopped mid-run
                order.status, order.error = "failed", "서버가 재시작되어 중단됨"
        store.save_orders(self.orders)

    # ---------- events ----------

    async def broadcast_forever(self) -> None:
        # A single consumer keeps events in emission order for every client.
        while True:
            event = await self.queue.get()
            if not event.get("transient"):  # transient: a nudge, not part of the run
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

    async def reset(self, mode: str, **scope: Any) -> None:
        await self.publish({"kind": "reset", "mode": mode, "t": time.time(), **scope})

    def orders_changed(self) -> None:
        store.save_orders(self.orders)
        self.queue.put_nowait({"kind": "orders", "t": time.time(), "transient": True})

    # ---------- the queue ----------

    async def run_queue(self) -> None:
        while True:
            await self.wake.wait()
            self.wake.clear()
            while not self.busy:
                order = next((o for o in self.orders if o.status == "queued"), None)
                if order is None:
                    break
                self.busy = True
                await self.run_order(order)

    async def run_order(self, order: Order) -> None:
        run_dir = RUNS_DIR / f"{datetime.now():%Y%m%d-%H%M%S}-{order.id}"
        run_dir.mkdir(parents=True)
        self.current = order
        order.status, order.started, order.run = "running", time.time(), run_dir.name
        self.orders_changed()
        self.record_file = run_dir / "events.jsonl"
        await self.reset("live", project_id=order.project_id, order_id=order.id)
        ended = False
        try:
            project = store.get_project(order.project_id)
            (run_dir / "order.json").write_text(
                json.dumps(
                    {
                        "order": order.model_dump(),
                        "project": {"id": project.id, "name": project.name},
                        "team": project.team.model_dump(),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            # A separate process can be killed mid-call; a thread cannot.
            self.proc = await asyncio.create_subprocess_exec(
                sys.executable, str(APP_DIR / "worker.py"), str(run_dir),
                stdout=asyncio.subprocess.PIPE,
                limit=16 * 1024 * 1024,  # the final report arrives as one line
            )
            if self.stopping:
                await self._kill()
            assert self.proc.stdout is not None
            async for line in self.proc.stdout:
                event = json.loads(line)
                if event["kind"] == "run_completed":
                    (run_dir / "report.md").write_text(event.get("report") or "", encoding="utf-8")
                    order.status, order.tokens = "done", event.get("total_tokens")
                elif event["kind"] == "run_failed":
                    order.status, order.error = "failed", event.get("error")
                ended = ended or event["kind"] in ("run_completed", "run_failed")
                await self.publish(event)
            code = await self.proc.wait()
            if self.stopping:
                order.status = "stopped"
                await self.publish({"kind": "run_stopped", "t": time.time()})
            elif not ended:
                order.status, order.error = "failed", f"worker exited with code {code}"
                await self.publish({"kind": "run_failed", "t": time.time(), "error": order.error})
        except Exception as e:  # surfaced in the office instead of killing the server
            order.status, order.error = "failed", str(e)
            await self.publish({"kind": "run_failed", "t": time.time(), "error": str(e)})
        finally:
            await self._kill()
            self.proc = None
            self.current = None
            order.ended = time.time()
            self.orders_changed()
            await self._finish()

    async def _kill(self) -> None:
        proc = self.proc
        if proc is None or proc.returncode is not None:
            return
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), STOP_GRACE)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()

    async def _finish(self) -> None:
        # Let queued events land in this run's file before closing it.
        while not self.queue.empty():
            await asyncio.sleep(0.05)
        self.record_file = None
        self.stopping = False
        self.job = None
        self.busy = False
        # Tells browsers to re-enable their buttons; end events arrive while still busy.
        await self.publish({"kind": "idle", "t": time.time()})
        self.wake.set()  # the next queued instruction, if any

    async def stop(self) -> None:
        self.stopping = True
        if self.proc is not None:
            await self._kill()
        elif self.job is not None:
            self.job.cancel()

    async def replay(self, path: Path, speed: float) -> None:
        events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
        scope = next((e for e in events if e["kind"] == "reset"), {})
        await self.reset("replay", project_id=scope.get("project_id"), order_id=scope.get("order_id"))
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
        except asyncio.CancelledError:
            await self.publish({"kind": "run_stopped", "t": time.time()})
        finally:
            await self._finish()


office = Office()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    tasks = [asyncio.create_task(office.broadcast_forever()), asyncio.create_task(office.run_queue())]
    office.wake.set()  # instructions queued before a restart
    yield
    await office._kill()  # never leave an orphaned crew spending tokens
    for task in tasks:
        task.cancel()


app = FastAPI(title="AI Office", lifespan=lifespan)


@app.middleware("http")
async def revalidate_static(request: Request, call_next: Any) -> Response:
    # Revalidate (ETag) on every load so edits to static files show up immediately.
    response: Response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


# ---------- status and recordings ----------


def _recordings() -> dict[str, tuple[Path, str]]:
    found = {f"sample/{p.stem}": (p, f"샘플: {p.stem}") for p in sorted(SAMPLES_DIR.glob("*.jsonl"))}
    for p in sorted(RUNS_DIR.glob("*/events.jsonl"), reverse=True):
        label = f"실행: {p.parent.name}"
        meta = p.parent / "order.json"
        if meta.exists():
            info = json.loads(meta.read_text(encoding="utf-8"))
            label = f"{info['project']['name']} · {info['order']['instruction'][:28]}"
        found[f"run/{p.parent.name}"] = (p, label)
    return found


def _claim() -> None:
    if office.busy:
        raise HTTPException(409, "다른 작업이 진행 중입니다.")
    office.busy = True


@app.get("/api/status")
async def status() -> dict[str, Any]:
    current = office.current
    return {
        "busy": office.busy,
        "has_api_key": bool(os.getenv("ANTHROPIC_API_KEY")),
        "recordings": [{"name": name, "label": label} for name, (_, label) in _recordings().items()],
        "current": {"order_id": current.id, "project_id": current.project_id} if current else None,
        "models": MODELS,
        "tools": TOOLS,
        "max_members": MAX_MEMBERS,
    }


class ReplayRequest(BaseModel):
    name: str
    speed: float = 1.0


@app.post("/api/replay")
async def replay(req: ReplayRequest) -> dict[str, str]:
    found = _recordings().get(req.name)
    if found is None:
        raise HTTPException(404, "녹화를 찾을 수 없습니다.")
    _claim()
    office.job = asyncio.create_task(office.replay(found[0], max(req.speed, 0.1)))
    return {"status": "started"}


@app.post("/api/stop")
async def stop() -> dict[str, str]:
    if not office.busy:
        raise HTTPException(409, "실행 중인 작업이 없습니다.")
    await office.stop()
    return {"status": "stopping"}


# ---------- businesses ----------


def _project(project_id: str) -> Project:
    try:
        return store.get_project(project_id)
    except KeyError:
        raise HTTPException(404, "사업을 찾을 수 없습니다.") from None


def _summary(p: Project) -> dict[str, Any]:
    return {"id": p.id, "name": p.name, "members": len(p.team.members), "created": p.created}


@app.get("/api/projects")
async def list_projects() -> list[dict[str, Any]]:
    return [_summary(p) for p in store.list_projects()]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    copy_from: str | None = None  # another business's team, or the default template


@app.post("/api/projects")
async def create_project(req: ProjectCreate) -> dict[str, Any]:
    team = _project(req.copy_from).team if req.copy_from else default_team()
    return _summary(store.create_project(req.name.strip(), team))


class ProjectRename(BaseModel):
    name: str = Field(min_length=1, max_length=40)


@app.patch("/api/projects/{project_id}")
async def rename_project(project_id: str, req: ProjectRename) -> dict[str, Any]:
    project = _project(project_id)
    project.name = req.name.strip()
    store.save_project(project)
    return _summary(project)


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str) -> dict[str, str]:
    _project(project_id)
    if len(store.list_projects()) <= 1:
        raise HTTPException(409, "사업은 최소 1개가 있어야 합니다.")
    if office.current and office.current.project_id == project_id:
        raise HTTPException(409, "이 사업의 업무가 진행 중입니다. 먼저 중지하세요.")
    for order in office.orders:
        if order.project_id == project_id and order.status == "queued":
            order.status = "cancelled"
    office.orders_changed()
    store.delete_project(project_id)
    return {"status": "deleted"}


@app.get("/api/projects/{project_id}/team")
async def get_team(project_id: str) -> dict[str, Any]:
    return {"team": _project(project_id).team.model_dump()}


@app.put("/api/projects/{project_id}/team")
async def put_team(project_id: str, team: Team) -> dict[str, Any]:
    # A running crew already copied its team, so saving mid-run is safe.
    project = _project(project_id)
    project.team = team
    store.save_project(project)
    return {"team": team.model_dump()}


@app.post("/api/projects/{project_id}/team/reset")
async def reset_team(project_id: str) -> dict[str, Any]:
    project = _project(project_id)
    project.team = default_team()
    store.save_project(project)
    return {"team": project.team.model_dump()}


# ---------- instructions ----------


@app.get("/api/orders")
async def list_orders(project_id: str | None = None) -> list[dict[str, Any]]:
    orders = [o for o in office.orders if project_id is None or o.project_id == project_id]
    return [o.model_dump() for o in reversed(orders)]


class OrderCreate(BaseModel):
    project_id: str
    instruction: str = Field(min_length=1, max_length=4000)


@app.post("/api/orders")
async def create_order(req: OrderCreate) -> dict[str, Any]:
    _project(req.project_id)
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise HTTPException(400, "ANTHROPIC_API_KEY가 없어 실행할 수 없습니다.")
    order = Order(id=store.new_id(), project_id=req.project_id, instruction=req.instruction.strip())
    office.orders.append(order)
    office.orders_changed()
    office.wake.set()
    return order.model_dump()


def _order(order_id: str) -> Order:
    order = next((o for o in office.orders if o.id == order_id), None)
    if order is None:
        raise HTTPException(404, "업무 지시를 찾을 수 없습니다.")
    return order


@app.delete("/api/orders/{order_id}")
async def cancel_order(order_id: str) -> dict[str, Any]:
    order = _order(order_id)
    if order.status != "queued":
        raise HTTPException(409, "대기 중인 지시만 취소할 수 있습니다.")
    order.status, order.ended = "cancelled", time.time()
    office.orders_changed()
    return order.model_dump()


@app.get("/api/orders/{order_id}/report")
async def order_report(order_id: str) -> dict[str, Any]:
    order = _order(order_id)
    report = RUNS_DIR / (order.run or "-") / "report.md"
    if not report.exists():
        raise HTTPException(404, "결과물이 없습니다.")
    return {"order": order.model_dump(), "report": report.read_text(encoding="utf-8")}


class Speed(BaseModel):
    speed: float = 2.0


@app.post("/api/orders/{order_id}/replay")
async def order_replay(order_id: str, req: Speed) -> dict[str, str]:
    order = _order(order_id)
    events = RUNS_DIR / (order.run or "-") / "events.jsonl"
    if not events.exists():
        raise HTTPException(404, "녹화가 없습니다.")
    _claim()
    office.job = asyncio.create_task(office.replay(events, max(req.speed, 0.1)))
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
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8765")))
