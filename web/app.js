const $ = (id) => document.getElementById(id);
const LABEL = { waiting: "En attente", called: "Appelé : présentez-vous au guichet",
  serving: "En cours de traitement", done: "Terminé", cancelled: "Annulé", no_show: "Absent à l'appel, ticket perdu" };
let snap = null, mine = Number(localStorage.getItem("ticket")) || null;

async function api(method, path) {
  const r = await fetch("/api" + path, { method, headers: { "X-Desk-Key": $("key").value } });
  if (!r.ok && r.status !== 204) {
    $("err").textContent = `${method} ${path} : ${r.status}`;
    return null;
  }
  $("err").textContent = "";
  return r.status === 204 ? {} : r.json();
}

async function refreshTicket() {
  if (!mine) return;
  const r = await fetch(`/api/tickets/${mine}`);
  if (!r.ok) { mine = null; localStorage.removeItem("ticket"); $("mine").hidden = true; return; }  // ticket disparu (base vidée)
  const t = await r.json();
  $("mine").hidden = false;
  $("n").textContent = t.number;
  let s = LABEL[t.status];
  if (t.status === "waiting") {
    s += ` : position ${t.position}, ` + (t.wait_minutes === null
      ? "guichets fermés" : `environ ${t.wait_minutes} min`);
  } else if (t.desk) s += ` (guichet ${t.desk})`;
  $("state").textContent = s;
  $("cancel").disabled = !["waiting", "called"].includes(t.status);
}

function render() {
  $("size").textContent = `${snap.queue.size} personne(s) en attente, ${snap.queue.open_desks} guichet(s) ouvert(s)`;
  $("desks").replaceChildren(...snap.desks.map((d) => {
    const el = document.createElement("div");
    el.className = "desk";
    const open = d.status === "open";
    el.append(`Guichet ${d.id} : ${open ? "ouvert" : "fermé"}${d.ticket ? `, ticket ${d.ticket}` : ""} `);
    for (const [label, act, ok] of [["Ouvrir", "open", !open], ["Fermer", "close", open],
      ["Appeler le suivant", "call-next", open && !d.ticket], ["Démarrer", "start", !!d.ticket], ["Terminer", "finish", !!d.ticket]]) {
      const b = document.createElement("button");
      b.textContent = label; b.disabled = !ok;
      b.onclick = () => api("POST", `/desks/${d.id}/${act}`);
      el.append(b);
    }
    return el;
  }));
}

$("take").onclick = async () => {
  const t = await api("POST", "/tickets");
  if (t) { mine = t.number; localStorage.setItem("ticket", mine); refreshTicket(); }
};
$("cancel").onclick = () => api("DELETE", `/tickets/${mine}`);
$("prioBtn").onclick = () => $("prio").value && api("POST", `/tickets/${$("prio").value}/prioritize`);

const es = new EventSource("/api/events");  // se reconnecte seul
es.onopen = () => { $("live").textContent = "en direct"; $("live").className = ""; };
es.onerror = () => { $("live").textContent = "hors ligne"; $("live").className = "off"; };
for (const ev of ["snapshot", "update"]) {
  es.addEventListener(ev, (e) => { snap = JSON.parse(e.data); render(); refreshTicket(); });
}
