// Scène 3D : la salle d'attente. Elle ne décide de rien, elle dessine l'état renvoyé par l'API.
import * as THREE from "three";

const COLS = 9, DX = 1.5, DZ = 1.4, ROW0_Z = -0.8;          // places de la file (serpentin)
const DOOR_IN = new THREE.Vector3(-13.2, 0, 5);
const MACHINE = new THREE.Vector3(-8.6, 0, 3.4);             // borne : le client y prend son ticket
const DOOR_OUT = [new THREE.Vector3(11.5, 0, 2), new THREE.Vector3(13.6, 0, 2)];
const SPEED = 3.2;
const SKINS = [0xf1c8a5, 0xe0ac82, 0xc68642, 0x8d5524, 0xffdbac];

const PALETTE = {
  light: { bg: 0xe8edf3, floorA: "#f4f0e8", floorB: "#e9e3d8", wall: 0xd9e1ea, counter: 0x6b7a90, top: 0xc9d3e0, hemi: 1.0, sun: 1.8 },
  dark:  { bg: 0x131821, floorA: "#2b313b", floorB: "#262b34", wall: 0x232b37, counter: 0x3b4658, top: 0x566277, hemi: 0.55, sun: 0.9 },
};

export const slotPos = (i) => {
  const row = Math.floor(i / COLS);
  let col = i % COLS;
  if (row % 2) col = COLS - 1 - col;
  return new THREE.Vector3((col - (COLS - 1) / 2) * DX, 0, ROW0_Z + row * DZ);
};

const labelTexture = (text, { bg = "rgba(15,23,42,.85)", fg = "#fff", w = 128, h = 64, size = 40 } = {}) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.fillStyle = bg;
  x.beginPath(); x.roundRect(2, 2, w - 4, h - 4, 14); x.fill();
  x.fillStyle = fg; x.font = `700 ${size}px system-ui, sans-serif`;
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

const sprite = (text, scale = [0.9, 0.45], opts) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text, opts), depthTest: false }));
  s.scale.set(...scale);
  s.renderOrder = 10;
  return s;
};

export function createWorld(canvas, { onPick }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  const LOOK = new THREE.Vector3(0, 0, 0.8);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a97a8, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(6, 12, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 12, bottom: -12, near: 1, far: 40 });
  scene.add(hemi, sun);

  const mat = (color, rough = 0.85) => new THREE.MeshStandardMaterial({ color, roughness: rough });
  const box = (w, h, d, m, x, y, z, parent = scene) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    b.castShadow = b.receiveShadow = true;
    parent.add(b);
    return b;
  };

  // --- salle ---
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(25, 17), new THREE.MeshStandardMaterial({ roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 1);
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMat = mat(0xffffff, 0.95);
  box(25.6, 4.5, 0.3, wallMat, 0, 2.25, -7.4);                         // fond
  box(0.3, 3.2, 11.4, wallMat, -12.65, 1.6, -1.85);                      // gauche : avant l'entrée
  box(0.3, 3.2, 3.4, wallMat, -12.65, 1.6, 7.85);                        // gauche : après l'entrée
  box(0.3, 3.2, 8.4, wallMat, 12.65, 1.6, -3.35);                        // droite : avant la sortie
  box(0.3, 3.2, 6.4, wallMat, 12.65, 1.6, 6.35);                         // droite : après la sortie
  const doorMat = mat(0x8b5e3c);
  box(0.4, 0.6, 2.4, doorMat, -12.65, 2.9, 5);                           // linteaux
  box(0.4, 0.6, 2.4, doorMat, 12.65, 2.9, 2);
  const enter = sprite("ENTRÉE", [1.8, 0.7], { w: 256, h: 100, size: 52 });
  enter.position.set(-12.2, 3.9, 5); scene.add(enter);
  const exit = sprite("SORTIE", [1.8, 0.7], { w: 256, h: 100, size: 52 });
  exit.position.set(12.2, 3.9, 2); scene.add(exit);

  // borne de tickets
  const kiosk = new THREE.Group();
  kiosk.position.set(-9.6, 0, 3.4);
  box(0.8, 1.5, 0.6, mat(0x334155), 0, 0.75, 0, kiosk);
  box(0.6, 0.4, 0.05, new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0ea5e9, emissiveIntensity: 0.6 }), 0, 1.15, 0.32, kiosk);
  scene.add(kiosk);
  const kioskLabel = sprite("TICKETS", [1.3, 0.5], { w: 192, h: 72, size: 40 });
  kioskLabel.position.set(-9.6, 2.1, 3.4); scene.add(kioskLabel);

  // tracé de la file au sol
  const pts = [];
  for (let i = 0; i < COLS * 4; i++) { const p = slotPos(i); p.y = 0.02; pts.push(p); }
  const lane = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0x94a3b8, dashSize: 0.25, gapSize: 0.2 }));
  lane.computeLineDistances();
  scene.add(lane);

  // --- guichets ---
  const desks = [];
  const counterMat = mat(0x6b7a90), topMat = mat(0xc9d3e0, 0.5);
  const lampOn = new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 1 });
  const lampOff = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.8 });
  const deskX = (i, n) => (i - (n - 1) / 2) * 6;
  const deskSpot = (i, n) => new THREE.Vector3(deskX(i, n), 0, -3.6);

  function buildDesks(n) {
    for (let i = 0; i < n; i++) {
      const x = deskX(i, n);
      box(3.4, 1.0, 1.1, counterMat, x, 0.5, -5.2);
      box(3.55, 0.08, 1.25, topMat, x, 1.04, -5.2);
      box(0.7, 0.45, 0.06, mat(0x0f172a), x + 0.9, 1.4, -5.3);       // écran de l'agent
      const clerk = person(0x1e40af, SKINS[(i + 1) % SKINS.length]);
      clerk.position.set(x, 0, -6.3);
      clerk.scale.setScalar(0);
      scene.add(clerk);
      const canvasBoard = document.createElement("canvas");
      canvasBoard.width = 512; canvasBoard.height = 256;
      const tex = new THREE.CanvasTexture(canvasBoard);
      tex.colorSpace = THREE.SRGBColorSpace;
      const board = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.3), new THREE.MeshBasicMaterial({ map: tex }));
      board.position.set(x, 3.0, -7.2);
      scene.add(board);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), lampOff);
      lamp.position.set(x, 3.95, -7.2);
      scene.add(lamp);
      desks.push({ id: i + 1, x, clerk, canvasBoard, tex, lamp, key: "", open: false });
    }
  }

  function drawBoard(d, open, number, status) {
    const key = `${open}|${number}|${status}`;
    if (key === d.key) return;
    d.key = key;
    const c = d.canvasBoard.getContext("2d");
    c.fillStyle = "#0f172a"; c.fillRect(0, 0, 512, 256);
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = "#94a3b8"; c.font = "600 34px system-ui, sans-serif";
    c.fillText(`GUICHET ${d.id}`, 256, 48);
    let text = "FERMÉ", color = "#ef4444";
    if (open && number == null) { text = "LIBRE"; color = "#22c55e"; }
    if (number != null) { text = String(number); color = status === "called" ? "#fbbf24" : "#4ade80"; }
    c.fillStyle = color; c.font = `800 ${number != null ? 120 : 84}px system-ui, sans-serif`;
    c.fillText(text, 256, 148);
    c.fillStyle = "#64748b"; c.font = "600 28px system-ui, sans-serif";
    c.fillText(number == null ? "" : status === "called" ? "APPELÉ" : "EN COURS", 256, 222);
    d.tex.needsUpdate = true;
    d.lamp.material = open ? lampOn : lampOff;
  }

  // --- personnes ---
  const bodyGeo = new THREE.CapsuleGeometry(0.26, 0.55, 4, 12);
  const headGeo = new THREE.SphereGeometry(0.21, 20, 16);
  const eyeGeo = new THREE.SphereGeometry(0.035, 8, 8);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111827 });
  const ringGeo = new THREE.RingGeometry(0.42, 0.52, 32);
  const selGeo = new THREE.RingGeometry(0.58, 0.78, 40);

  function person(shirt, skin) {
    const g = new THREE.Group();
    const inner = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, mat(shirt, 0.7)); body.position.y = 0.56;
    const head = new THREE.Mesh(headGeo, mat(skin, 0.6)); head.position.y = 1.33;
    body.castShadow = head.castShadow = true;
    inner.add(body, head);
    for (const sx of [-0.08, 0.08]) {
      const e = new THREE.Mesh(eyeGeo, eyeMat); e.position.set(sx, 1.36, 0.19); inner.add(e);
    }
    g.add(inner);
    g.userData.inner = inner;
    return g;
  }

  const people = new Map();   // numéro -> { g, ring, sel, label, route, pause, want, leaving, ... }
  const tmp = new THREE.Vector3();
  let nDesks = 0, selected = null, instantNext = true;

  const destOf = (want) => want.kind === "desk" ? deskSpot(want.desk - 1, nDesks) : slotPos(want.index);

  function spawn(n, want, instant) {
    const hue = (n * 47) % 360;
    const g = person(new THREE.Color(`hsl(${hue}, 55%, 50%)`), SKINS[n % SKINS.length]);
    g.userData.n = n;
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false;
    const sel = new THREE.Mesh(selGeo, new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide }));
    sel.rotation.x = -Math.PI / 2; sel.position.y = 0.04; sel.visible = false;
    const label = sprite(String(n));
    label.position.y = 1.95;
    g.add(ring, sel, label);
    const p = { n, g, ring, sel, label, route: [], pause: 0, want, leaving: false, moving: false, phase: Math.random() * 6 };
    if (instant) g.position.copy(destOf(want));
    else { g.position.copy(DOOR_IN); p.route.push({ pos: MACHINE, wait: 0.9 }); }
    scene.add(g);
    people.set(n, p);
    return p;
  }

  function dispose(p) {
    scene.remove(p.g);
    p.label.material.map.dispose(); p.label.material.dispose();
    people.delete(p.n);
  }

  function setRing(p, color, pulse) {
    p.ring.visible = color != null;
    if (color != null) p.ring.material.color.set(color);
    p.pulse = !!pulse;
  }

  function applyWant(p) {
    const w = p.want;
    if (w.kind === "desk") setRing(p, w.status === "called" ? 0xfbbf24 : 0x22c55e, w.status === "called");
    else setRing(p, w.priority ? 0xf59e0b : null, false);
  }

  // --- API publique ---
  function sync({ desks: deskState, people: wants }) {
    if (!nDesks) { nDesks = deskState.length; buildDesks(nDesks); }
    deskState.forEach((d, i) => {
      const at = d.at;
      drawBoard(desks[i], d.status === "open", at ? at.number : null, at ? at.status : null);
      desks[i].open = d.status === "open";
    });
    for (const [n, want] of wants) {
      const p = people.get(n) ?? spawn(n, want, instantNext);
      p.want = want;
      applyWant(p);
    }
    instantNext = false;
  }

  function leave(n, outcome) {
    const p = people.get(n);
    if (!p || p.leaving) return;
    p.leaving = true;
    p.route = DOOR_OUT.map((pos) => ({ pos }));
    setRing(p, outcome === "done" ? 0x22c55e : 0xef4444, false);
  }

  function select(n) {
    selected = n;
    for (const p of people.values()) p.sel.visible = p.n === n;
  }

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([...people.values()].map((p) => p.g), true);
    let o = hits[0]?.object;
    while (o && o.userData.n == null) o = o.parent;
    onPick(o ? o.userData.n : null);
  });

  function setTheme(dark) {
    const P = PALETTE[dark ? "dark" : "light"];
    scene.background = new THREE.Color(P.bg);
    wallMat.color.set(P.wall); counterMat.color.set(P.counter); topMat.color.set(P.top);
    hemi.intensity = P.hemi; sun.intensity = P.sun;
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d");
    x.fillStyle = P.floorA; x.fillRect(0, 0, 64, 64);
    x.fillStyle = P.floorB; x.fillRect(0, 0, 32, 32); x.fillRect(32, 32, 32, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(12.5, 8.5);
    floor.material.map?.dispose();
    floor.material.map = t; floor.material.needsUpdate = true;
  }

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = { x: 0 };
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  });

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // recule jusqu'à ce que toute la salle (±15.5) tienne en largeur
    const hFov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
    camera.userData.dist = Math.max(15.5 / Math.tan(hFov / 2), 21);
  }
  new ResizeObserver(resize).observe(canvas);

  let last = performance.now(), camX = 0;
  const dir = new THREE.Vector3(0, 0.62, 0.78).normalize();
  let winStart = performance.now(), winFrames = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.2), t = now / 1000;
    last = now;
    // rendu logiciel ou GPU faible : sous 24 i/s, on passe en pixel ratio 1 (une seule fois)
    winFrames++;
    if (now - winStart > 1500) {
      if (winFrames / ((now - winStart) / 1000) < 24 && renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); resize(); }
      winStart = now; winFrames = 0;
    }
    camX += ((reduced ? 0 : pointer.x * 1.5) - camX) * Math.min(1, dt * 3);
    camera.position.copy(LOOK).addScaledVector(dir, camera.userData.dist ?? 21);
    camera.position.x += camX;
    camera.lookAt(LOOK);

    desks.forEach((d) => {
      const s = d.clerk.scale.x, goal = d.open ? 1 : 0;
      d.clerk.scale.setScalar(s + (goal - s) * Math.min(1, dt * 6));
    });

    for (const p of [...people.values()]) {
      const target = p.route.length ? p.route[0].pos : destOf(p.want);
      tmp.subVectors(target, p.g.position); tmp.y = 0;
      const dist = tmp.length();
      p.moving = false;
      if (p.pause > 0) p.pause -= dt;
      else if (dist > 0.06) {
        p.g.position.addScaledVector(tmp, Math.min(dist, SPEED * dt) / dist);
        p.moving = true;
        let da = Math.atan2(tmp.x, tmp.z) - p.g.rotation.y;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        p.g.rotation.y += da * Math.min(1, dt * 10);
      } else if (p.route.length) {
        const r = p.route.shift();
        p.pause = r.wait ?? 0;
        if (p.leaving && !p.route.length) { dispose(p); continue; }
      } else {
        let da = Math.PI - p.g.rotation.y;                      // à l'arrêt : face aux guichets
        da = Math.atan2(Math.sin(da), Math.cos(da));
        p.g.rotation.y += da * Math.min(1, dt * 6);
      }
      p.g.userData.inner.position.y = p.moving && !reduced ? Math.abs(Math.sin(t * 9 + p.phase)) * 0.07 : 0;
      if (p.ring.visible) p.ring.material.opacity = p.pulse && !reduced ? 0.5 + 0.5 * Math.sin(t * 6) : 1;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  setTheme(matchMedia("(prefers-color-scheme: dark)").matches);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => setTheme(e.matches));
  resize();
  requestAnimationFrame(frame);

  return { sync, leave, select };
}
