"""Règles de la file (SPEC §4 et §6). Redis est la seule source de vérité.

Les transitions touchant plusieurs clés sont des scripts Lua atomiques.
shortcut: les scripts construisent leurs clés ("ticket:"..n), donc pas compatibles Redis Cluster ; passer à KEYS si on clusterise.
"""
import math
import time

SCORE_CLASS = 10**10  # score = classe x 10^10 + numéro ; classe 0 = prioritaire, 1 = normal
HISTORY = 10
DEFAULT_SERVICE_S = 300


class Missing(Exception):
    pass


class Conflict(Exception):
    pass


# Chaque script renvoie un entier (numéro de ticket) ou un code texte d'erreur.
CALL_NEXT = """
local d = 'desk:'..ARGV[1]
if redis.call('HGET', d, 'status') ~= 'open' then return 'closed' end
if redis.call('HEXISTS', d, 'ticket') == 1 then return 'busy' end
local z = redis.call('ZPOPMIN', 'queue')
if #z == 0 then return 'empty' end
local n = z[1]
redis.call('HSET', 'ticket:'..n, 'status', 'called', 'desk', ARGV[1], 'called_at', ARGV[2])
redis.call('ZADD', 'called', ARGV[2] + ARGV[3], n)
redis.call('HSET', d, 'ticket', n)
return tonumber(n)
"""

START = """
local t = redis.call('HGET', 'desk:'..ARGV[1], 'ticket')
if not t then return 'idle' end
if redis.call('HGET', 'ticket:'..t, 'status') ~= 'called' then return 'conflict' end
redis.call('ZREM', 'called', t)
redis.call('HSET', 'ticket:'..t, 'status', 'serving', 'started_at', ARGV[2])
return tonumber(t)
"""

FINISH = """
local d = 'desk:'..ARGV[1]
local t = redis.call('HGET', d, 'ticket')
if not t then return 'idle' end
local k = 'ticket:'..t
if redis.call('HGET', k, 'status') ~= 'serving' then return 'conflict' end
redis.call('HSET', k, 'status', 'done', 'ended_at', ARGV[2])
redis.call('HDEL', d, 'ticket')
redis.call('LPUSH', 'stats:durations', ARGV[2] - redis.call('HGET', k, 'started_at'))
redis.call('LTRIM', 'stats:durations', 0, 9)
return tonumber(t)
"""

# Le ticket retenu par le guichet repart dans la file avec son score d'origine.
CLOSE = """
local d = 'desk:'..ARGV[1]
redis.call('HSET', d, 'status', 'closed')
local t = redis.call('HGET', d, 'ticket')
if t then
  local k = 'ticket:'..t
  redis.call('ZADD', 'queue', redis.call('HGET', k, 'score'), t)
  redis.call('ZREM', 'called', t)
  redis.call('HSET', k, 'status', 'waiting')
  redis.call('HDEL', k, 'desk', 'called_at', 'started_at')
  redis.call('HDEL', d, 'ticket')
end
return 1
"""

CANCEL = """
local k = 'ticket:'..ARGV[1]
local s = redis.call('HGET', k, 'status')
if not s then return 'missing' end
if s == 'waiting' then
  redis.call('ZREM', 'queue', ARGV[1])
elseif s == 'called' then
  redis.call('ZREM', 'called', ARGV[1])
  redis.call('HDEL', 'desk:'..redis.call('HGET', k, 'desk'), 'ticket')
else
  return 'conflict'
end
redis.call('HSET', k, 'status', 'cancelled', 'ended_at', ARGV[2])
return 1
"""

PRIORITIZE = """
local k = 'ticket:'..ARGV[1]
local s = redis.call('HGET', k, 'status')
if not s then return 'missing' end
if s ~= 'waiting' then return 'conflict' end
redis.call('ZADD', 'queue', ARGV[1], ARGV[1])
redis.call('HSET', k, 'priority', 1, 'score', ARGV[1])
return 1
"""

SWEEP = """
local ts = redis.call('ZRANGEBYSCORE', 'called', '-inf', ARGV[1])
for _, t in ipairs(ts) do
  local k = 'ticket:'..t
  redis.call('ZREM', 'called', t)
  redis.call('HDEL', 'desk:'..redis.call('HGET', k, 'desk'), 'ticket')
  redis.call('HSET', k, 'status', 'no_show', 'ended_at', ARGV[1])
end
return #ts
"""


class Queue:
    def __init__(self, r, desk_count, noshow_s):
        self.r, self.desk_count, self.noshow_s = r, desk_count, noshow_s
        self._s = {name: r.register_script(src) for name, src in dict(
            call_next=CALL_NEXT, start=START, finish=FINISH, close=CLOSE,
            cancel=CANCEL, prioritize=PRIORITIZE, sweep=SWEEP).items()}

    def init_desks(self):
        for d in range(1, self.desk_count + 1):
            self.r.sadd("desks", d)
            self.r.hsetnx(f"desk:{d}", "status", "closed")  # ne touche pas un guichet déjà ouvert

    def _run(self, name, *args):
        out = self._s[name](args=[str(a) for a in args])
        if out == "missing":
            raise Missing
        if isinstance(out, str):  # closed, busy, idle, conflict
            if out == "empty":
                return None
            raise Conflict(out)
        self.r.publish("events", "1")
        return out

    def _desk(self, d):
        if not self.r.sismember("desks", d):
            raise Missing

    # --- tickets ---
    def take(self):
        n = self.r.incr("ticket:seq")
        with self.r.pipeline() as p:
            p.hset(f"ticket:{n}", mapping=dict(
                status="waiting", priority=0, score=SCORE_CLASS + n, created_at=time.time()))
            p.zadd("queue", {n: SCORE_CLASS + n})
            p.execute()
        self.r.publish("events", "1")
        return self.ticket(n)

    def ticket(self, n):
        t = self.r.hgetall(f"ticket:{n}")
        if not t:
            raise Missing
        out = dict(number=int(n), status=t["status"], priority=t["priority"] == "1",
                   desk=int(t["desk"]) if "desk" in t else None, position=None, wait_minutes=None)
        if t["status"] == "waiting":
            out["position"] = self.r.zrank("queue", n) + 1
            out["wait_minutes"] = self.wait_minutes(out["position"])
        return out

    def cancel(self, n):
        self._run("cancel", n, time.time())
        return self.ticket(n)

    def prioritize(self, n):
        self._run("prioritize", n)
        return self.ticket(n)

    # --- guichets ---
    def open(self, d):
        self._desk(d)
        self.r.hset(f"desk:{d}", "status", "open")
        self.r.publish("events", "1")
        return self.desk(d)

    def close(self, d):
        self._desk(d)
        self._run("close", d)
        return self.desk(d)

    def call_next(self, d):
        self._desk(d)
        n = self._run("call_next", d, time.time(), self.noshow_s)
        return None if n is None else self.ticket(n)

    def start(self, d):
        self._desk(d)
        return self.ticket(self._run("start", d, time.time()))

    def finish(self, d):
        self._desk(d)
        return self.ticket(self._run("finish", d, time.time()))

    def desk(self, d):
        h = self.r.hgetall(f"desk:{d}")
        return dict(id=int(d), status=h["status"], ticket=int(h["ticket"]) if "ticket" in h else None)

    def desks(self):
        return [self.desk(d) for d in sorted(int(x) for x in self.r.smembers("desks"))]

    # --- file, attente, état ---
    def wait_minutes(self, position):
        open_desks = sum(d["status"] == "open" for d in self.desks())
        if not open_desks:
            return None
        h = [float(x) for x in self.r.lrange("stats:durations", 0, HISTORY - 1)]
        avg = sum(h) / len(h) if h else DEFAULT_SERVICE_S
        return math.ceil(avg * position / open_desks / 60)

    def queue(self):
        nxt = self.r.zrange("queue", 0, 4, withscores=True)
        return dict(size=self.r.zcard("queue"),
                    open_desks=sum(d["status"] == "open" for d in self.desks()),
                    next=[dict(number=int(n), priority=s < SCORE_CLASS) for n, s in nxt])

    def snapshot(self):
        # waiting et at_desks permettent au front de dessiner chaque personne sans requête par ticket
        desks = self.desks()
        waiting = self.r.zrange("queue", 0, -1, withscores=True)
        at_desks = []
        for d in desks:
            if d["ticket"] is not None:
                status, prio = self.r.hmget(f"ticket:{d['ticket']}", "status", "priority")
                at_desks.append(dict(desk=d["id"], number=d["ticket"], status=status, priority=prio == "1"))
        return dict(queue=self.queue(), desks=desks, at_desks=at_desks,
                    waiting=[dict(number=int(n), priority=s < SCORE_CLASS) for n, s in waiting])

    def sweep(self, now=None):
        n = self._s["sweep"](args=[str(now or time.time())])
        if n:
            self.r.publish("events", "1")
        return n
