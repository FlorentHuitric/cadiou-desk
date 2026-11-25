import os

import pytest
import redis
from fastapi.testclient import TestClient

from app.main import create_app

# DB 15 : jamais la base de l'appli (DB 0), car le fixture la vide.
URL = os.environ.get("TEST_REDIS_URL", "redis://redis:6379/15")
KEY = {"X-Desk-Key": "k"}


@pytest.fixture
def client(monkeypatch):
    for k, v in dict(REDIS_URL=URL, DESK_KEY="k", DESK_COUNT="2", NOSHOW_SECONDS="60").items():
        monkeypatch.setenv(k, v)
    redis.Redis.from_url(URL).flushdb()
    with TestClient(create_app()) as c:
        yield c
    redis.Redis.from_url(URL).flushdb()


@pytest.fixture
def q(client):
    return client.app.state.q


def post(c, path, key=True):
    return c.post(f"/api{path}", headers=KEY if key else {})


def take(c):
    return c.post("/api/tickets").json()["number"]


def open_desk(c, d=1):
    assert post(c, f"/desks/{d}/open").status_code == 200


def order(c):
    return [t["number"] for t in c.get("/api/queue").json()["next"]]
