import asyncio
import hmac
import json
import os
from contextlib import asynccontextmanager

import redis
import redis.asyncio as aredis
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.queue import Conflict, Missing, Queue


def create_app():
    key = os.environ.get("DESK_KEY")
    if not key:
        raise RuntimeError("DESK_KEY manquante : l'API refuse de démarrer sans clé agent")
    url = os.environ.get("REDIS_URL", "redis://redis:6379")
    q = Queue(redis.Redis.from_url(url, decode_responses=True),
              int(os.environ.get("DESK_COUNT", 3)), int(os.environ.get("NOSHOW_SECONDS", 60)))

    @asynccontextmanager
    async def lifespan(app):
        for _ in range(30):
            try:
                await asyncio.to_thread(q.init_desks)
                break
            except redis.ConnectionError:
                await asyncio.sleep(1)  # pod : Redis démarre en même temps que l'API
        else:
            await asyncio.to_thread(q.init_desks)  # abandonne avec la vraie erreur

        async def sweeper():
            while True:
                try:
                    await asyncio.to_thread(q.sweep)
                except redis.RedisError:
                    pass  # Redis indisponible : on réessaie au tour suivant
                await asyncio.sleep(1)

        task = asyncio.create_task(sweeper())
        yield
        task.cancel()

    app = FastAPI(title="Cadiou Desk", lifespan=lifespan)
    app.state.q = q

    @app.exception_handler(Missing)
    def _missing(_, __):
        return JSONResponse({"detail": "introuvable"}, 404)

    @app.exception_handler(Conflict)
    def _conflict(_, exc):
        return JSONResponse({"detail": f"transition interdite ({exc})"}, 409)

    def agent(request: Request):
        sent = request.headers.get("X-Desk-Key", "")
        if not hmac.compare_digest(sent.encode(), key.encode()):
            raise HTTPException(401, "clé agent absente ou fausse")

    api = APIRouter(prefix="/api")
    secured = APIRouter(prefix="/api", dependencies=[Depends(agent)])

    @api.post("/tickets")
    def take():
        return q.take()

    @api.get("/tickets/{n}")
    def get_ticket(n: int):
        return q.ticket(n)

    @api.delete("/tickets/{n}")
    def cancel(n: int):
        return q.cancel(n)

    @api.get("/queue")
    def queue():
        return q.queue()

    @api.get("/desks")
    def desks():
        return q.desks()

    @api.get("/healthz")
    def healthz():
        try:
            q.r.ping()
        except redis.RedisError:
            raise HTTPException(503, "redis injoignable")
        return {"status": "ok"}

    @secured.post("/tickets/{n}/prioritize")
    def prioritize(n: int):
        return q.prioritize(n)

    @secured.post("/desks/{d}/open")
    def open_desk(d: int):
        return q.open(d)

    @secured.post("/desks/{d}/close")
    def close_desk(d: int):
        return q.close(d)

    @secured.post("/desks/{d}/call-next")
    def call_next(d: int):
        t = q.call_next(d)
        return Response(status_code=204) if t is None else t

    @secured.post("/desks/{d}/start")
    def start(d: int):
        return q.start(d)

    @secured.post("/desks/{d}/finish")
    def finish(d: int):
        return q.finish(d)

    @api.get("/events")
    async def events():
        def sse(name, data):
            return f"event: {name}\ndata: {json.dumps(data)}\n\n"

        async def stream():
            ar = aredis.Redis.from_url(url, decode_responses=True)
            ps = ar.pubsub(ignore_subscribe_messages=True)
            await ps.subscribe("events")  # avant le snapshot : aucun changement perdu
            try:
                yield sse("snapshot", await asyncio.to_thread(q.snapshot))
                while True:
                    if await ps.get_message(timeout=15) is None:
                        yield ": ping\n\n"
                    else:
                        yield sse("update", await asyncio.to_thread(q.snapshot))
            finally:
                await ps.aclose()
                await ar.aclose()

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    app.include_router(api)
    app.include_router(secured)
    return app
