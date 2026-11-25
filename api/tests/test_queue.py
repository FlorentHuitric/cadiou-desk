import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from conftest import KEY, open_desk, order, post, take


def ticket(c, n):
    return c.get(f"/api/tickets/{n}").json()


# --- tickets, position, attente -------------------------------------------

def test_positions_are_fifo(client):
    ns = [take(client) for _ in range(3)]
    assert ns == [1, 2, 3]
    assert [ticket(client, n)["position"] for n in ns] == [1, 2, 3]
    assert ticket(client, 1)["status"] == "waiting"


def test_unknown_ticket_and_desk_404(client):
    assert client.get("/api/tickets/99").status_code == 404
    assert client.delete("/api/tickets/99").status_code == 404
    assert post(client, "/tickets/99/prioritize").status_code == 404
    assert post(client, "/desks/3/open").status_code == 404  # DESK_COUNT=2


def test_wait_estimate(client, q):
    take(client), take(client)
    assert ticket(client, 2)["wait_minutes"] is None  # aucun guichet ouvert
    open_desk(client, 1)
    assert ticket(client, 2)["wait_minutes"] == 10  # 300 s par défaut x 2
    open_desk(client, 2)
    assert ticket(client, 2)["wait_minutes"] == 5  # 2 guichets
    q.r.lpush("stats:durations", 60, 60)
    assert ticket(client, 2)["wait_minutes"] == 1  # moyenne 60 s
    take(client)
    assert ticket(client, 3)["wait_minutes"] == 2  # 60 x 3 / 2 = 90 s -> 2 min


def test_last_desk_closed_wait_is_none(client):
    take(client)
    open_desk(client)
    assert ticket(client, 1)["wait_minutes"] == 5
    post(client, "/desks/1/close")
    assert ticket(client, 1)["wait_minutes"] is None


# --- clé agent --------------------------------------------------------------

@pytest.mark.parametrize("path", [
    "/tickets/1/prioritize", "/desks/1/open", "/desks/1/close",
    "/desks/1/call-next", "/desks/1/start", "/desks/1/finish",
])
def test_agent_routes_need_key(client, path):
    take(client)
    assert post(client, path, key=False).status_code == 401
    assert client.post(f"/api{path}", headers={"X-Desk-Key": "nope"}).status_code == 401


def test_api_refuses_to_start_without_key(monkeypatch):
    monkeypatch.delenv("DESK_KEY", raising=False)
    with pytest.raises(RuntimeError):
        create_app()


def test_healthz(client):
    assert client.get("/api/healthz").json() == {"status": "ok"}


# --- priorité ---------------------------------------------------------------

def test_priority_goes_first_then_fifo_among_priority(client):
    for _ in range(3):
        take(client)
    assert post(client, "/tickets/3/prioritize").status_code == 200
    assert order(client) == [3, 1, 2]
    post(client, "/tickets/2/prioritize")
    assert order(client) == [2, 3, 1]  # 2 est arrivé avant 3
    assert ticket(client, 1)["position"] == 3
    assert post(client, "/tickets/2/prioritize").status_code == 200  # idempotent


def test_prioritize_only_waiting(client):
    open_desk(client)
    take(client)
    post(client, "/desks/1/call-next")
    assert post(client, "/tickets/1/prioritize").status_code == 409


# --- appel du suivant -------------------------------------------------------

def test_call_next_follows_queue_and_assigns_desk(client):
    take(client), take(client)
    open_desk(client, 1), open_desk(client, 2)
    r = post(client, "/desks/1/call-next")
    assert r.status_code == 200 and r.json()["number"] == 1
    assert ticket(client, 1)["status"] == "called" and ticket(client, 1)["desk"] == 1
    assert post(client, "/desks/1/call-next").status_code == 409  # déjà occupé
    assert post(client, "/desks/2/call-next").json()["number"] == 2


def test_call_next_closed_desk_409_and_empty_204(client):
    take(client)
    assert post(client, "/desks/1/call-next").status_code == 409
    open_desk(client)
    post(client, "/desks/1/call-next")
    open_desk(client, 2)
    assert post(client, "/desks/2/call-next").status_code == 204


def test_call_next_never_gives_same_ticket_twice(client, q):
    take(client)
    open_desk(client, 1), open_desk(client, 2)
    got, barrier = [], threading.Barrier(2)

    def go(d):
        barrier.wait()
        got.append(q.call_next(d))

    ts = [threading.Thread(target=go, args=(d,)) for d in (1, 2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(g is None for g in got) == [False, True]


# --- service ----------------------------------------------------------------

def test_service_cycle_records_duration(client, q):
    take(client)
    open_desk(client)
    post(client, "/desks/1/call-next")
    assert post(client, "/desks/1/start").json()["status"] == "serving"
    assert post(client, "/desks/1/finish").json()["status"] == "done"
    assert q.r.llen("stats:durations") == 1
    assert client.get("/api/desks").json()[0]["ticket"] is None


def test_start_finish_conflicts(client):
    open_desk(client)
    assert post(client, "/desks/1/start").status_code == 409  # rien à démarrer
    assert post(client, "/desks/1/finish").status_code == 409
    take(client)
    post(client, "/desks/1/call-next")
    assert post(client, "/desks/1/finish").status_code == 409  # appelé, pas encore en service


# --- abandon ----------------------------------------------------------------

def test_cancel_waiting_shifts_positions(client):
    for _ in range(3):
        take(client)
    assert client.delete("/api/tickets/1").status_code == 200
    assert ticket(client, 1)["status"] == "cancelled"
    assert ticket(client, 2)["position"] == 1


def test_cancel_called_frees_desk(client):
    open_desk(client)
    take(client)
    post(client, "/desks/1/call-next")
    assert client.delete("/api/tickets/1").status_code == 200
    take(client)
    assert post(client, "/desks/1/call-next").json()["number"] == 2


def test_cancel_serving_or_finished_409(client):
    open_desk(client)
    take(client)
    post(client, "/desks/1/call-next"), post(client, "/desks/1/start")
    assert client.delete("/api/tickets/1").status_code == 409
    post(client, "/desks/1/finish")
    assert client.delete("/api/tickets/1").status_code == 409


# --- fermeture d'un guichet -------------------------------------------------

@pytest.mark.parametrize("serving", [False, True])
def test_close_desk_requeues_ticket_with_its_rank(client, q, serving):
    for _ in range(3):
        take(client)
    open_desk(client)
    post(client, "/desks/1/call-next")
    if serving:
        post(client, "/desks/1/start")
    post(client, "/tickets/3/prioritize")
    post(client, "/desks/1/close")
    assert ticket(client, 1)["status"] == "waiting"
    assert order(client) == [3, 1, 2]
    assert q.r.llen("stats:durations") == 0
    assert client.get("/api/desks").json()[0] == {"id": 1, "status": "closed", "ticket": None}


# --- no-show ----------------------------------------------------------------

def test_no_show_after_deadline(client, q):
    open_desk(client)
    take(client), take(client)
    post(client, "/desks/1/call-next")
    assert q.sweep(now=time.time() + 10) == 0
    assert ticket(client, 1)["status"] == "called"
    assert q.sweep(now=time.time() + 61) == 1
    assert ticket(client, 1)["status"] == "no_show"
    assert post(client, "/desks/1/call-next").json()["number"] == 2  # guichet libéré


# --- état, SSE, redémarrage -------------------------------------------------

def test_snapshot_and_queue_view(client, q):
    take(client), take(client)
    open_desk(client)
    post(client, "/tickets/2/prioritize")
    snap = q.snapshot()
    assert snap["queue"] == client.get("/api/queue").json()
    assert snap["queue"] == {
        "size": 2, "open_desks": 1,
        "next": [{"number": 2, "priority": True}, {"number": 1, "priority": False}],
    }
    assert [d["status"] for d in snap["desks"]] == ["open", "closed"]


def test_every_change_publishes_an_event(client, q):
    ps = q.r.pubsub(ignore_subscribe_messages=True)
    ps.subscribe("events")
    ps.get_message(timeout=1)  # confirmation d'abonnement
    take(client)
    assert ps.get_message(timeout=2) is not None


def test_state_survives_app_restart(client):
    open_desk(client)
    take(client)
    with TestClient(create_app()) as c2:  # le démarrage ne remet pas les guichets à zéro
        assert c2.get("/api/desks").json()[0]["status"] == "open"
        assert c2.get("/api/queue").json()["size"] == 1
