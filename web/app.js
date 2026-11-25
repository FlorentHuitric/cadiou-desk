import { createWorld } from "./scene.js";

const $ = (id) => document.getElementById(id);
const STATUS = { waiting: "En attente", called: "Appelé", serving: "En cours de service",
  done: "Servi", cancelled: "A abandonné", no_show: "Absent à l'appel" };

// --- clé agent (stockée dans ce navigateur) ---
try { $("key").value = localStorage.getItem("deskKey") ?? ""; } catch {}
$("key").addEventListener("input", () => { try { localStorage.setItem("deskKey", $("key").value); } catch {} });

// --- petits utilitaires ---
const h = (tag, attrs = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), attrs);
  el.append(...kids);
  return el;
};
let toastTimer;
function toast(msg) {
  $("toast").textContent = msg; $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3500);
}
function log(msg) {
  const li = h("li", {}, h("time", { textContent: new Date().toLocaleTimeString("fr-FR") }), msg);
  $("log").prepend(li);
  while ($("log").children.length > 40) $("log").lastChild.remove();
}

async function call(method, path) {
  let r;
  try { r = await fetch("/api" + path, { method, headers: { "X-Desk-Key": $("key").value } }); }
  catch { toast("API injoignable"); return null; }
  if (r.status === 401) { toast("Clé agent absente ou incorrecte"); $("keybox").open = true; $("key").focus(); return null; }
  if (r.status === 409) { toast("Action impossible dans l'état actuel"); return null; }
  if (!r.ok) { toast(`Erreur ${r.status}`); return null; }
  return r.status === 204 ? {} : r.json();
}

// --- état ---
const world = createWorld($("scene"), { onPick: (n) => select(n) });
let snap = null, prev = null, prevDesks = new Map(), selected = null;

function onSnapshot(s) {
  snap = s;
  const first = prev === null;
  const cur = new Map();
  s.waiting.forEach((t, index) => cur.set(t.number, { kind: "queue", index, priority: t.priority }));
  s.at_desks.forEach((t) => cur.set(t.number, { kind: "desk", desk: t.desk, status: t.status, priority: t.priority }));

  if (!first) {
    for (const [n, c] of cur) {
      const p = prev.get(n);
      if (!p) log(`Client N° ${n} arrivé${c.priority ? " (prioritaire)" : ""}`);
      else if (p.kind === "queue" && c.kind === "desk") log(`N° ${n} appelé au guichet ${c.desk}`);
      else if (p.kind === "desk" && c.kind === "desk" && p.status !== c.status) log(`N° ${n} en cours au guichet ${c.desk}`);
      else if (p.kind === "desk" && c.kind === "queue") log(`N° ${n} remis en file (guichet fermé)`);
      else if (p.kind === "queue" && c.kind === "queue" && !p.priority && c.priority) log(`N° ${n} passe en priorité`);
    }
    for (const d of s.desks) {
      const was = prevDesks.get(d.id);
      if (was && was !== d.status) log(`Guichet ${d.id} ${d.status === "open" ? "ouvert" : "fermé"}`);
    }
  }
  prevDesks = new Map(s.desks.map((d) => [d.id, d.status]));

  const atDesk = new Map(s.at_desks.map((t) => [t.desk, t]));
  world.sync({
    desks: s.desks.map((d) => ({ ...d, at: atDesk.get(d.id) ?? null })),
    people: cur,
  });
  if (!first) for (const n of prev.keys()) if (!cur.has(n)) leave(n);
  prev = cur;

  $("c-queue").textContent = s.queue.size;
  $("c-open").textContent = `${s.queue.open_desks}/${s.desks.length}`;
  $("c-serving").textContent = s.at_desks.filter((t) => t.status === "serving").length;
  $("scene").setAttribute("aria-label", `Salle d'attente : ${s.queue.size} en file, ${s.queue.open_desks} guichet(s) ouvert(s)`);
  renderDesks();
  refreshSel();
}

async function leave(n) {
  let status = "gone";  // ticket introuvable ou API injoignable : il repart sans commentaire
  try {
    const r = await fetch(`/api/tickets/${n}`);
    if (r.ok) status = (await r.json()).status;
  } catch {}
  world.leave(n, status);
  const msg = { done: `N° ${n} servi, il repart`, cancelled: `N° ${n} a abandonné la file`,
    no_show: `N° ${n} absent à l'appel, ticket perdu` }[status];
  if (msg) log(msg);
}

// --- guichets ---
let desksSig = "";
function renderDesks() {
  // ne reconstruit que si un guichet a changé : sinon le focus clavier saute à chaque événement
  const sig = JSON.stringify([snap.desks, snap.at_desks, snap.waiting.length === 0]);
  if (sig === desksSig) return;
  desksSig = sig;
  const focused = document.activeElement?.closest?.(".desk");
  const focusDesk = focused ? [...$("desks").children].indexOf(focused) : -1;
  const atDesk = new Map(snap.at_desks.map((t) => [t.desk, t]));
  $("desks").replaceChildren(...snap.desks.map((d) => {
    const t = atDesk.get(d.id), open = d.status === "open";
    const act = (path) => () => call("POST", `/desks/${d.id}/${path}`);
    const badge = !open ? ["Fermé", "bad"]
      : !t ? ["Libre", "free"]
      : t.status === "called" ? [`Appelé N° ${t.number}`, "called"] : [`En cours N° ${t.number}`, "serving"];
    const main = !open ? h("button", { className: "primary", textContent: "Ouvrir", onclick: act("open") })
      : !t ? h("button", { className: "primary", textContent: "Appeler le suivant", disabled: snap.waiting.length === 0, onclick: act("call-next") })
      : t.status === "called" ? h("button", { className: "primary", textContent: "Le client est là : démarrer", onclick: act("start") })
      : h("button", { className: "primary", textContent: "Terminer le service", onclick: act("finish") });
    const row = h("div", { className: "row" }, main);
    if (open) row.append(h("button", { textContent: "Fermer", title: t ? "Le client repart dans la file" : "", onclick: act("close") }));
    return h("div", { className: "desk" },
      h("div", { className: "desk-head" }, `Guichet ${d.id}`, h("span", { className: `badge ${badge[1]}`, textContent: badge[0] })),
      row);
  }));
  if (focusDesk >= 0) $("desks").children[focusDesk]?.querySelector("button")?.focus();  // le bouton principal du même guichet
}

// --- arrivées ---
async function arrive(priority) {
  if (priority && !$("key").value) {
    toast("Clé agent requise pour une arrivée prioritaire");
    $("keybox").open = true; $("key").focus();
    return;
  }
  const t = await call("POST", "/tickets");
  // priorisation refusée (clé fausse) : on retire le ticket plutôt que de laisser un client normal
  if (t && priority && !(await call("POST", `/tickets/${t.number}/prioritize`))) await call("DELETE", `/tickets/${t.number}`);
}
$("arrive").onclick = () => arrive(false);
$("arrive-prio").onclick = () => arrive(true);

// --- sélection d'un client ---
let selSig = "";
function select(n) {
  selected = n;
  selSig = "";
  world.select(n);
  refreshSel();
}

async function refreshSel() {
  const n = selected;
  $("sel").hidden = n === null;
  if (n === null) return;
  let r;
  try { r = await fetch(`/api/tickets/${n}`); } catch { return; }
  if (selected !== n) return;  // la sélection a changé pendant la requête
  if (!r.ok) return select(null);
  const t = await r.json();
  const sig = JSON.stringify(t);
  if (sig === selSig) return;  // rien n'a changé : on garde le focus
  selSig = sig;
  const rows = [["Statut", STATUS[t.status]]];
  if (t.status === "waiting") {
    rows.push(["Position", t.position],
      ["Attente", t.wait_minutes === null ? "guichets fermés" : `environ ${t.wait_minutes} min`]);
  }
  if (t.desk) rows.push(["Guichet", t.desk]);
  if (t.priority) rows.push(["Priorité", "oui"]);
  const dl = h("dl", { className: "kv" });
  rows.forEach(([k, v]) => dl.append(h("dt", { textContent: k }), h("dd", { textContent: v })));
  const actions = h("div", { className: "row" });
  if (t.status === "waiting" && !t.priority) actions.append(h("button", { textContent: "Passage prioritaire", onclick: () => call("POST", `/tickets/${n}/prioritize`) }));
  if (["waiting", "called"].includes(t.status)) actions.append(h("button", { className: "danger", textContent: "Faire abandonner", onclick: () => call("DELETE", `/tickets/${n}`) }));
  $("sel-body").replaceChildren(h("p", {}, h("b", { textContent: `N° ${n}` })), dl, actions);
}

// --- temps réel ---
const es = new EventSource("/api/events");  // se reconnecte seul
es.onopen = () => { $("live").textContent = "en direct"; $("live").className = "pill"; };
es.onerror = () => { $("live").textContent = "hors ligne"; $("live").className = "pill off"; };
for (const ev of ["snapshot", "update"]) es.addEventListener(ev, (e) => onSnapshot(JSON.parse(e.data)));
