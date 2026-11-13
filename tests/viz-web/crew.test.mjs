// Tests de viz/public/js/crew.js (ADR 0011) : cycle nominal, verdicts, places, dossier, non-mutation, pureté, et rejeu
// du journal tests/fixtures/journal/cycle-complet.jsonl à travers state.js puis stepCrew.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stepCrew, verdictClip, BUBBLE_MS, SIT_MS, GESTURE_MS } from "../../viz/public/js/crew.js";
import { characterFor } from "../../viz/public/js/assets.js";
import { devSeat, seatFor, waypoints, MAX_DEV_SEATS, OFFICE } from "../../viz/public/js/office-layout.js";
import { durationOf } from "../../viz/public/js/paths.js";
import { init, apply, tick } from "../../viz/public/js/state.js";
import { agent, stateOf, assertPure } from "./support.mjs";

const T = 1_000_000;
const WALK = 3500; // plus que MAX_WALK_MS : toute marche est finie
const model = (...agents) => ({ agents });
const STATION = { developpeur: "dev", architecte: "cadrage", verificateur: "verification", testeur: "test" };
const A = (id, type, extra = {}) => agent(id, { type, station: STATION[type], ...extra });
const DEV = (id, extra) => A(id, "developpeur", extra);
const VER = (id, extra) => A(id, "verificateur", extra);
const TST = (id, extra) => A(id, "testeur", extra);
const by = (crew, id) => crew.find((b) => b.id === id);
const team = (crew) => crew.filter((b) => b.id !== "pm");
const seatKeys = (crew) => team(crew).map((b) => b.seat);

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
}

// Place un agent à son poste (marche terminée) en phase `phase`.
function seated(a, phase = "running") {
  const first = stepCrew([], model({ ...a, phase }), [], T);
  return stepCrew(first, model({ ...a, phase }), [], T + WALK);
}

describe("forme d'un bonhomme et entrée", () => {
  test("chaque bonhomme porte id, role, seat, model, state, clip, position, heading, bubble et folder", () => {
    const [b] = stepCrew([], model(DEV("d1", { issue: 5 })), [], T);
    for (const key of ["id", "role", "seat", "model", "state", "clip", "position", "heading", "bubble", "folder"]) assert.ok(key in b, key);
    assert.equal(b.id, "d1");
    assert.equal(b.role, "developpeur");
    assert.equal(b.seat, "dev:0");
    assert.deepEqual(b.model, characterFor("developpeur", 0));
  });

  test("à l'ajout : entering, clip walk, à la porte, sans dossier", () => {
    const [b] = stepCrew([], model(DEV("d1", { issue: 5 })), [], T);
    const door = waypoints()["dev:0"][0];
    assert.equal(b.state, "entering");
    assert.equal(b.clip, "walk");
    assert.deepEqual([b.position.x, b.position.z], [door.x, door.z]);
    assert.equal(b.folder, null);
  });

  test("en marche, la position avance sur le trajet de paths.js, du côté du poste", () => {
    const route = waypoints()["dev:0"];
    const total = durationOf(route);
    const first = stepCrew([], model(DEV("d1")), [], T);
    const mid = by(stepCrew(first, model(DEV("d1")), [], T + total / 2), "d1");
    assert.equal(mid.state, "entering");
    const door = route[0];
    assert.ok(Math.hypot(mid.position.x - door.x, mid.position.z - door.z) > 0.5, "il a quitté la porte");
    assert.equal(mid.clip, "walk");
  });
});

describe("cycle nominal", () => {
  test("working : arrivé au poste en phase running, sit puis interact-right, position du poste", () => {
    const first = stepCrew([], model(DEV("d1")), [], T);
    const arrival = T + durationOf(waypoints()["dev:0"]);
    const justIn = by(stepCrew(first, model(DEV("d1")), [], arrival + 100), "d1");
    assert.equal(justIn.state, "working");
    assert.equal(justIn.clip, "sit");
    assert.deepEqual([justIn.position.x, justIn.position.z], [devSeat(0).x, devSeat(0).z]);
    assert.equal(justIn.heading, devSeat(0).rotation);
    const typing = by(stepCrew(first, model(DEV("d1")), [], arrival + SIT_MS + 100), "d1");
    assert.equal(typing.clip, "interact-right");
  });

  test("la phase requested travaille comme running", () => {
    assert.equal(by(seated(DEV("d1"), "requested"), "d1").state, "working");
  });

  test("leaving : phase finished, walk vers la porte ; gone à la porte", () => {
    const crew = seated(DEV("d1"));
    const leaving = stepCrew(crew, model(DEV("d1", { phase: "finished" })), [], T + WALK + 100);
    assert.equal(leaving[0].state, "leaving");
    assert.equal(leaving[0].clip, "walk");
    const gone = stepCrew(leaving, model(DEV("d1", { phase: "finished" })), [], T + 2 * WALK + 200);
    assert.equal(gone[0].state, "gone");
    const door = waypoints()["dev:0"][0];
    assert.deepEqual([gone[0].position.x, gone[0].position.z], [door.x, door.z]);
    assert.equal(gone[0].folder, null);
  });

  test("un agent déjà finished à sa première apparition n'entre pas : gone", () => {
    assert.equal(stepCrew([], model(DEV("d1", { phase: "finished" })), [], T)[0].state, "gone");
  });

  test("unknown : stale, idle, bulle « ? »", () => {
    const [b] = seated(DEV("d1"), "unknown");
    assert.equal(b.state, "stale");
    assert.equal(b.clip, "idle");
    assert.equal(b.bubble, "?");
  });

  test("une marche déjà finie au pas suivant n'est pas rejouée (l'arrivée a lieu à l'heure exacte)", () => {
    const first = stepCrew([], model(DEV("d1")), [], T);
    const arrival = T + durationOf(waypoints()["dev:0"]);
    const b = stepCrew(first, model(DEV("d1")), [], arrival + 10 * SIT_MS)[0];
    assert.equal(b.clip, "interact-right");
  });
});

describe("verdicts et bulle", () => {
  const cases = [
    ["PASS", "emote-yes"], ["LIVRÉ", "emote-yes"], ["APPROUVÉ", "emote-yes"],
    ["FAIL", "emote-no"], ["BLOQUÉ", "emote-no"], ["À REVOIR", "emote-no"],
    ["AUTRE", "holding-both"], [null, "holding-both"],
  ];
  for (const [verdict, clip] of cases) {
    test(`phase reported, verdict ${verdict} : reporting, ${clip}`, () => {
      const [b] = seated(VER("v1", { verdict }), "reported");
      assert.equal(b.state, "reporting");
      assert.equal(b.clip, clip);
      assert.equal(b.bubble, verdict);
      assert.equal(verdictClip(verdict), clip);
    });
  }

  test("la bulle dure 4 s à partir de la phase reported, puis le bonhomme se rassied", () => {
    const a = VER("v1", { verdict: "PASS" });
    const working = seated(a, "running");
    const t0 = T + WALK + 500;
    const r = stepCrew(working, model({ ...a, phase: "reported" }), [], t0);
    assert.equal(r[0].bubble, "PASS");
    const before = stepCrew(r, model({ ...a, phase: "reported" }), [], t0 + BUBBLE_MS - 1);
    assert.equal(before[0].bubble, "PASS");
    assert.equal(before[0].clip, "emote-yes");
    const after = stepCrew(before, model({ ...a, phase: "reported" }), [], t0 + BUBBLE_MS);
    assert.equal(after[0].bubble, null);
    assert.equal(after[0].clip, "sit");
    assert.equal(after[0].state, "reporting");
    const later = stepCrew(after, model({ ...a, phase: "reported" }), [], t0 + 60_000);
    assert.equal(later[0].clip, "sit");
  });

  test("reported reçu pendant la marche : la bulle dure 4 s à partir de l'arrivée", () => {
    const a = VER("v1", { verdict: "FAIL", phase: "reported" });
    const first = stepCrew([], model(VER("v1", { verdict: "FAIL" })), [], T);
    const arrival = T + durationOf(waypoints()["verification:0"]);
    const mid = stepCrew(first, model(a), [], T + 100);
    assert.equal(mid[0].state, "entering");
    assert.equal(mid[0].bubble, null);
    const here = stepCrew(mid, model(a), [], arrival + 3000);
    assert.equal(here[0].state, "reporting");
    assert.equal(here[0].bubble, "FAIL");
    const done = stepCrew(here, model(a), [], arrival + BUBBLE_MS + 1);
    assert.equal(done[0].bubble, null);
  });
});

describe("attribution des places", () => {
  test("4 développeurs simultanés : postes 0 à 3, dont un supplémentaire, modèles selon l'indice", () => {
    const ids = ["d1", "d2", "d3", "d4"];
    const crew = team(stepCrew([], model(...ids.map((id) => DEV(id))), [], T));
    assert.deepEqual(seatKeys(crew), ["dev:0", "dev:1", "dev:2", "dev:3"]);
    assert.equal(devSeat(3).extra, true);
    crew.forEach((b, i) => assert.deepEqual(b.model, characterFor("developpeur", i)));
  });

  test("plus de développeurs que de postes : le dernier poste est réutilisé", () => {
    const ids = Array.from({ length: MAX_DEV_SEATS + 1 }, (_, i) => `d${i}`);
    const crew = team(stepCrew([], model(...ids.map((id) => DEV(id))), [], T));
    assert.equal(crew[MAX_DEV_SEATS].seat, `dev:${MAX_DEV_SEATS - 1}`);
  });

  test("2 vérificateurs simultanés : 2 places distinctes, la seconde debout en interact-right sans sit", () => {
    const crew = stepCrew(seated(VER("v1")), model(VER("v1"), VER("v2")), [], T + WALK + 10);
    const both = stepCrew(crew, model(VER("v1"), VER("v2")), [], T + 2 * WALK + 10);
    assert.deepEqual(seatKeys(both), ["verification:0", "verification:1"]);
    assert.notDeepEqual(both[0].position, both[1].position);
    assert.equal(both[1].state, "working");
    assert.equal(both[1].clip, "interact-right");
    for (const now of [T + WALK + 20, T + 2 * WALK + 20, T + 2 * WALK + 2000]) {
      const c = stepCrew(both, model(VER("v1"), VER("v2")), [], now);
      assert.notEqual(by(c, "v2").clip, "sit");
    }
  });

  test("4 testeurs : le 4e prend la dernière place", () => {
    const crew = stepCrew([], model(TST("t1"), TST("t2"), TST("t3"), TST("t4")), [], T);
    assert.deepEqual(seatKeys(crew), ["test:0", "test:1", "test:2", "test:2"]);
  });

  test("architecte à station null : salle de réunion (cadrage)", () => {
    const [b] = stepCrew([], model(A("a1", "architecte", { station: null })), [], T);
    assert.equal(b.seat, "cadrage:0");
  });

  test("architecte au kanban : debout, idle (pas de frappe)", () => {
    const [b] = seated(A("a1", "architecte", { station: "roadmap" }));
    assert.equal(b.state, "working");
    assert.equal(b.clip, "idle");
    assert.deepEqual([b.position.x, b.position.z], [seatFor("roadmap", "architecte", 0).x, seatFor("roadmap", "architecte", 0).z]);
  });

  test("architecte en salle de réunion : assis, sit puis interact-right", () => {
    const first = stepCrew([], model(A("a1", "architecte")), [], T);
    const arrival = T + durationOf(waypoints()["cadrage:0"]);
    assert.equal(stepCrew(first, model(A("a1", "architecte")), [], arrival + 10)[0].clip, "sit");
    assert.equal(stepCrew(first, model(A("a1", "architecte")), [], arrival + SIT_MS + 10)[0].clip, "interact-right");
  });

  test("agent-move pendant la présence : le bonhomme ne bouge pas de place", () => {
    const a = A("a1", "architecte", { station: "cadrage" });
    const crew = seated(a);
    const moved = stepCrew(crew, model({ ...a, station: "roadmap" }), [{ kind: "agent-move", id: "a1", from: "cadrage", to: "roadmap" }], T + WALK + 50);
    assert.equal(moved[0].seat, "cadrage:0");
    assert.deepEqual(moved[0].position, crew[0].position);
  });

  test("la place est libérée quand l'agent sort du modèle, puis réattribuée au suivant", () => {
    const crew = stepCrew([], model(VER("v1"), VER("v2")), [], T);
    assert.deepEqual(seatKeys(crew), ["verification:0", "verification:1"]);
    const afterRemoval = stepCrew(crew, model(VER("v2")), [{ kind: "agent-remove", id: "v1", from: "verification", to: null }], T + 1000);
    assert.deepEqual(seatKeys(afterRemoval), ["verification:1"]);
    const next = stepCrew(afterRemoval, model(VER("v2"), VER("v3")), [], T + 2000);
    assert.equal(by(next, "v3").seat, "verification:0");
    assert.equal(by(next, "v2").seat, "verification:1", "la place de v2 reste fixée");
  });

  test("un agent fini garde sa place tant qu'il est dans le modèle", () => {
    const crew = stepCrew([], model(VER("v1", { phase: "finished" })), [], T);
    const next = stepCrew(crew, model(VER("v1", { phase: "finished" }), VER("v2")), [], T + 10);
    assert.equal(by(next, "v2").seat, "verification:1");
  });

  test("un agent sans place (station merge) n'a pas de bonhomme", () => {
    assert.deepEqual(stepCrew([], model(A("x", "developpeur", { station: "merge" }), A("y", "testeur", { station: null })), [], T).map((b) => b.id), ["x", "pm"]);
  });
});

describe("interruptions de marche", () => {
  test("finished pendant entering : demi-tour depuis la position courante, puis gone", () => {
    const first = stepCrew([], model(DEV("d1")), [], T);
    const total = durationOf(waypoints()["dev:0"]);
    const mid = stepCrew(first, model(DEV("d1")), [], T + total / 2);
    const turned = stepCrew(mid, model(DEV("d1", { phase: "finished" })), [], T + total / 2 + 1);
    assert.equal(turned[0].state, "leaving");
    assert.ok(Math.abs(turned[0].position.x - mid[0].position.x) < 0.1);
    const gone = stepCrew(turned, model(DEV("d1", { phase: "finished" })), [], T + total / 2 + WALK + 10);
    assert.equal(gone[0].state, "gone");
  });

  test("reprise après gone : entering vers le même poste, puis working", () => {
    const gone = stepCrew(stepCrew(seated(DEV("d1")), model(DEV("d1", { phase: "finished" })), [], T + WALK + 10), model(DEV("d1", { phase: "finished" })), [], T + 2 * WALK + 100);
    assert.equal(gone[0].state, "gone");
    const back = stepCrew(gone, model(DEV("d1")), [], T + 2 * WALK + 200);
    assert.equal(back[0].state, "entering");
    assert.equal(back[0].seat, "dev:0");
    const seatedAgain = stepCrew(back, model(DEV("d1")), [], T + 3 * WALK + 400);
    assert.equal(seatedAgain[0].state, "working");
  });

  test("reprise pendant leaving : repart vers le poste depuis la position courante", () => {
    const leaving = stepCrew(seated(DEV("d1")), model(DEV("d1", { phase: "finished" })), [], T + WALK + 10);
    const back = stepCrew(leaving, model(DEV("d1")), [], T + WALK + 600);
    assert.equal(back[0].state, "entering");
  });
});

describe("dossier", () => {
  test("visible sur le poste avec #N quand l'agent porte une issue, retiré à la sortie", () => {
    const [b] = seated(DEV("d1", { issue: 42 }));
    assert.equal(b.folder.label, "#42");
    assert.deepEqual([b.folder.x, b.folder.z], [devSeat(0).x, devSeat(0).z]);
    const leaving = stepCrew([b], model(DEV("d1", { issue: 42, phase: "finished" })), [], T + WALK + 50);
    assert.equal(leaving[0].folder, null);
  });

  test("sans issue : pas de dossier", () => {
    assert.equal(seated(DEV("d1"))[0].folder, null);
  });
});

describe("mode réduit", () => {
  test("pas de marche : working directement au poste, gone directement à la sortie", () => {
    const first = stepCrew([], model(DEV("d1")), [], T, true);
    assert.equal(first[0].state, "working");
    assert.deepEqual([first[0].position.x, first[0].position.z], [devSeat(0).x, devSeat(0).z]);
    const left = stepCrew(first, model(DEV("d1", { phase: "finished" })), [], T + 10, true);
    assert.equal(left[0].state, "gone");
  });
});

describe("pureté", () => {
  test("stepCrew ne mute ni le bonhomme, ni le modèle, ni les transitions", () => {
    const m = deepFreeze(model(DEV("d1", { issue: 3 }), VER("v1", { verdict: "PASS" })));
    const tr = deepFreeze([{ kind: "agent-add", id: "d1", from: null, to: "dev" }]);
    const crew = deepFreeze(stepCrew([], m, tr, T));
    const m2 = deepFreeze(model(DEV("d1", { issue: 3, phase: "reported", verdict: "LIVRÉ" })));
    const next = stepCrew(crew, m2, tr, T + WALK);
    const again = stepCrew(crew, m2, tr, T + WALK);
    assert.notEqual(next, crew);
    assert.deepEqual(next, again);
  });

  test("crew.js est pur : ni three, ni DOM, ni horloge, ni hasard", async () => {
    await assertPure("crew.js");
  });
});

describe("rejeu du journal cycle-complet.jsonl", () => {
  const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "journal", "cycle-complet.jsonl");
  const events = fs.readFileSync(FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  function replay(reduced = false) {
    let m = init(stateOf({}));
    let crew = [];
    const states = new Map(); // id -> suites d'états sans répétition
    const seatsByAgent = new Map();
    const clips = new Map(); // id -> clips de reporting vus
    const pmClips = new Set();
    const observe = (now) => {
      for (const b of crew) {
        if (b.id === "pm") {
          pmClips.add(b.clip);
          continue;
        }
        const seq = states.get(b.id) ?? [];
        if (seq.at(-1) !== b.state) seq.push(b.state);
        states.set(b.id, seq);
        seatsByAgent.set(b.id, b.seat);
        if (b.state === "reporting" && b.bubble) clips.set(b.id, b.clip);
        // pas d'état impossible : working seulement sur le poste, walk seulement en marche
        const seat = b.seat.startsWith("dev:") ? devSeat(Number(b.seat.slice(4))) : seatFor(b.seat.split(":")[0], b.role, Number(b.seat.split(":")[1]));
        if (b.state === "working") assert.deepEqual([b.position.x, b.position.z], [seat.x, seat.z], `${b.id} working hors poste à ${now}`);
        assert.equal(b.clip === "walk", b.state === "entering" || b.state === "leaving", `${b.id} ${b.state} ${b.clip}`);
        if (b.state === "gone") assert.equal(b.folder, null);
      }
    };
    let t = Date.parse(events[0].ts);
    for (const ev of events) {
      const at = Date.parse(ev.ts);
      for (; t < at; t += 250) {
        crew = stepCrew(crew, m, [], t, reduced);
        observe(t);
      }
      const r = apply(m, { event: "evt", data: JSON.stringify(ev) });
      m = r.model;
      crew = stepCrew(crew, m, r.transitions, at, reduced);
      observe(at);
      t = at;
    }
    for (const stop = t + 20_000; t < stop; t += 250) {
      crew = stepCrew(crew, m, [], t, reduced);
      observe(t);
    }
    return { m, crew, states, seatsByAgent, clips, pmClips, end: t };
  }

  const cycle = ["entering", "working", "reporting", "leaving", "gone"];

  test("les quatre types d'agents, des feature.status et un pr.merged sont dans la fixture", () => {
    const types = new Set(events.filter((e) => e.agentType).map((e) => e.agentType.split(":")[1]));
    assert.deepEqual([...types].sort(), ["architecte", "developpeur", "testeur", "verificateur"]);
    assert.ok(events.some((e) => e.type === "feature.status"));
    assert.ok(events.some((e) => e.type === "pr.merged"));
  });

  test("chaque agent suit la suite d'états attendue, sans état impossible", () => {
    const { states } = replay();
    assert.deepEqual(states.get("tu-arch"), cycle);
    assert.deepEqual(states.get("tu-dev"), [...cycle, "entering", "working", "reporting", "leaving", "gone"]);
    assert.deepEqual(states.get("tu-ver1"), cycle);
    assert.deepEqual(states.get("tu-ver2"), cycle);
    assert.deepEqual(states.get("tu-test"), cycle);
  });

  test("les deux vérificateurs successifs occupent deux places distinctes ; l'architecte est au kanban", () => {
    const { seatsByAgent } = replay();
    assert.equal(seatsByAgent.get("tu-ver1"), "verification:0");
    assert.equal(seatsByAgent.get("tu-ver2"), "verification:1");
    assert.equal(seatsByAgent.get("tu-arch"), "roadmap:0");
    assert.equal(seatsByAgent.get("tu-dev"), "dev:0");
    assert.equal(seatsByAgent.get("tu-test"), "test:0");
  });

  test("chaque verdict de la fixture joue le clip attendu", () => {
    const { clips } = replay();
    assert.equal(clips.get("tu-arch"), "emote-yes");
    assert.equal(clips.get("tu-ver1"), "emote-no");
    assert.equal(clips.get("tu-ver2"), "emote-yes");
    assert.equal(clips.get("tu-test"), "emote-yes");
  });

  test("après le TTL des agents terminés, state.js les retire : l'équipe est vide et les places sont libres", () => {
    const { m, crew, end } = replay();
    const purged = tick(m, new Date(end + 11 * 60 * 1000).toISOString());
    const after = stepCrew(crew, purged.model, purged.transitions, end + 11 * 60 * 1000);
    assert.deepEqual(team(after), []);
  });

  test("la reprise de l'agent (finished puis running) rend le même bonhomme au même poste", () => {
    const { states, seatsByAgent } = replay();
    assert.equal(states.get("tu-dev").filter((s) => s === "gone").length, 2);
    assert.equal(seatsByAgent.get("tu-dev"), "dev:0");
  });

  test("le chef de projet est assis au repos et fait un geste sur les changements de la fixture", () => {
    const { pmClips } = replay();
    assert.deepEqual([...pmClips].sort(), ["interact-right", "sit"]);
  });

  test("rejouée en mode réduit : aucune marche, aucune position intermédiaire, mêmes états finaux", () => {
    const { states, clips, pmClips, m } = replay(true);
    for (const [id, seq] of states) {
      assert.ok(!seq.includes("entering") && !seq.includes("leaving"), `${id} : ${seq}`);
    }
    assert.deepEqual(states.get("tu-dev"), ["working", "reporting", "gone", "working", "reporting", "gone"]);
    assert.equal(clips.get("tu-ver1"), "emote-no");
    assert.deepEqual([...pmClips], ["sit"]);
    assert.ok(m.agents.length > 0);
  });

  test("en mode réduit, chaque pas place le bonhomme au poste ou à la porte, jamais entre les deux", () => {
    const door = (b) => waypoints()[b.seat][0];
    let crew = [];
    let m = init(stateOf({}));
    let t = Date.parse(events[0].ts);
    for (const ev of events) {
      const at = Date.parse(ev.ts);
      const r = apply(m, { event: "evt", data: JSON.stringify(ev) });
      m = r.model;
      for (let k = 0; k < 4; k++) {
        crew = stepCrew(crew, m, k === 0 ? r.transitions : [], at + k * 100, true);
        for (const b of team(crew)) {
          const seat = b.seat.startsWith("dev:") ? devSeat(Number(b.seat.slice(4))) : seatFor(b.seat.split(":")[0], b.role, Number(b.seat.split(":")[1]));
          const target = b.state === "gone" ? door(b) : seat;
          assert.deepEqual([b.position.x, b.position.z], [target.x, target.z], `${b.id} ${b.state}`);
          assert.equal(b.frozen, true);
        }
      }
      t = at;
    }
    assert.ok(t > 0);
  });
});

describe("interruptions : reprise, poste, transition en attente", () => {
  test("reprise (finished puis reported) pendant leaving : même poste, bulle de 4 s depuis l'arrivée", () => {
    const a = VER("v1", { verdict: "PASS" });
    const leaving = stepCrew(seated(a), model({ ...a, phase: "finished" }), [], T + WALK + 10);
    assert.equal(leaving[0].state, "leaving");
    const back = stepCrew(leaving, model({ ...a, phase: "reported" }), [], T + WALK + 300);
    assert.equal(back[0].state, "entering");
    assert.equal(back[0].seat, "verification:0");
    const arrival = T + WALK + 300 + 3000; // la marche dure au plus 3 s
    const here = stepCrew(back, model({ ...a, phase: "reported" }), [], arrival);
    assert.equal(here[0].state, "reporting");
    assert.equal(here[0].bubble, "PASS");
    const landed = here[0].reportedAt; // instant réel d'arrivée, après la reprise et avant `arrival`
    assert.ok(landed > T + WALK + 300 && landed <= arrival, "la bulle part de l'arrivée, pas de la reprise");
    assert.equal(stepCrew(here, model({ ...a, phase: "reported" }), [], landed + BUBBLE_MS - 1)[0].bubble, "PASS");
    assert.equal(stepCrew(here, model({ ...a, phase: "reported" }), [], landed + BUBBLE_MS)[0].bubble, null);
  });

  test("reprise après gone : poste repris par un autre, le bonhomme prend la première place libre", () => {
    const f = (a) => ({ ...a, phase: "finished" });
    let t = T;
    let crew = stepCrew([], model(VER("v1"), VER("v2"), VER("v3")), [], t);
    crew = stepCrew(crew, model(VER("v1"), VER("v2"), VER("v3")), [], (t += WALK));
    assert.deepEqual(seatKeys(crew), ["verification:0", "verification:1", "verification:2"]);
    // v1 sort : sa place 0 n'est plus tenue que par un bonhomme sorti.
    crew = stepCrew(crew, model(f(VER("v1")), VER("v2"), VER("v3")), [], (t += 10));
    crew = stepCrew(crew, model(f(VER("v1")), VER("v2"), VER("v3")), [], (t += WALK));
    assert.equal(by(crew, "v1").state, "gone");
    // v4 arrive : plus de place libre, il prend la place 0 de v1.
    crew = stepCrew(crew, model(f(VER("v1")), VER("v2"), VER("v3"), VER("v4")), [], (t += 10));
    assert.equal(by(crew, "v4").seat, "verification:0");
    // v2 sort à son tour.
    crew = stepCrew(crew, model(f(VER("v1")), f(VER("v2")), VER("v3"), VER("v4")), [], (t += WALK));
    crew = stepCrew(crew, model(f(VER("v1")), f(VER("v2")), VER("v3"), VER("v4")), [], (t += WALK));
    assert.equal(by(crew, "v2").state, "gone");
    // v1 revient : sa place est prise, il prend la première place libre (celle de v2, sortie).
    crew = stepCrew(crew, model(VER("v1"), f(VER("v2")), VER("v3"), VER("v4")), [], (t + 10));
    assert.equal(by(crew, "v1").state, "entering");
    assert.equal(by(crew, "v1").seat, "verification:1");
    assert.equal(by(crew, "v4").seat, "verification:0", "le poste occupé ne bouge pas");
  });

  test("reprise après gone : poste libre, le bonhomme retrouve le même", () => {
    const f = (a) => ({ ...a, phase: "finished" });
    let t = T + WALK;
    let crew = seated(VER("v1"));
    crew = stepCrew(crew, model(f(VER("v1")), VER("v2")), [], (t += 10));
    crew = stepCrew(crew, model(f(VER("v1")), VER("v2")), [], (t += WALK));
    assert.equal(by(crew, "v1").state, "gone");
    assert.equal(by(crew, "v2").seat, "verification:1");
    crew = stepCrew(crew, model(VER("v1"), VER("v2")), [], (t + 10));
    assert.equal(by(crew, "v1").seat, "verification:0");
    assert.equal(by(crew, "v1").state, "entering");
  });

  test("deux changements pendant une marche : seul le dernier compte", () => {
    const a = VER("v1", { verdict: "PASS" });
    const first = stepCrew([], model(a), [], T);
    const arrival = T + durationOf(waypoints()["verification:0"]);
    const mid = stepCrew(first, model({ ...a, phase: "reported" }), [], T + 100);
    const mid2 = stepCrew(mid, model({ ...a, phase: "unknown" }), [], T + 200);
    assert.equal(mid2[0].state, "entering");
    const stale = stepCrew(mid2, model({ ...a, phase: "unknown" }), [], arrival + 10);
    assert.equal(stale[0].state, "stale");
    assert.equal(stale[0].bubble, "?");
    // reported puis retour à running : on arrive et on travaille, sans bulle de verdict.
    const m3 = stepCrew(first, model({ ...a, phase: "reported" }), [], T + 100);
    const m4 = stepCrew(m3, model(a), [], T + 200);
    const there = stepCrew(m4, model(a), [], arrival + 10);
    assert.equal(there[0].state, "working");
    assert.equal(there[0].bubble, null);
  });

  test("finished puis retour à running pendant entering : le bonhomme repart vers le poste depuis sa position", () => {
    const first = stepCrew([], model(DEV("d1")), [], T);
    const total = durationOf(waypoints()["dev:0"]);
    const mid = stepCrew(first, model(DEV("d1")), [], T + total / 2);
    const turned = stepCrew(mid, model(DEV("d1", { phase: "finished" })), [], T + total / 2 + 100);
    const again = stepCrew(turned, model(DEV("d1")), [], T + total / 2 + 200);
    assert.equal(again[0].state, "entering");
    assert.ok(Math.hypot(again[0].position.x - mid[0].position.x, again[0].position.z - mid[0].position.z) < 1.5);
  });
});

describe("chef de projet", () => {
  const pm = (crew) => by(crew, "pm");
  const empty = model();
  const kinds = {
    "feature-move": { kind: "feature-move", id: 1, from: "dev", to: "verification" },
    "feature-status": { kind: "feature-status", id: 1, from: "in-progress", to: "in-review" },
    "release merged": { kind: "release", id: "release/1", from: "open", to: "merged" },
  };

  test("toujours présent, assis sans taper au repos, à son bureau", () => {
    const crew = stepCrew([], empty, [], T);
    assert.equal(pm(crew).state, "working");
    assert.equal(pm(crew).clip, "sit");
    assert.equal(pm(crew).seat, "pm");
    assert.deepEqual(pm(crew).model, characterFor("chef-de-projet"));
    assert.equal(pm(crew).heading, OFFICE.pm.rotation);
    for (let k = 1; k < 20; k++) assert.equal(pm(stepCrew(crew, empty, [], T + k * 1000)).clip, "sit");
  });

  for (const [name, tr] of Object.entries(kinds)) {
    test(`geste sur ${name} : un cycle d'interact-right puis retour à sit`, () => {
      const c0 = stepCrew([], empty, [], T);
      const c1 = stepCrew(c0, empty, [tr], T + 100);
      assert.equal(pm(c1).clip, "interact-right");
      const c2 = stepCrew(c1, empty, [], T + 100 + GESTURE_MS - 1);
      assert.equal(pm(c2).clip, "interact-right");
      const c3 = stepCrew(c2, empty, [], T + 100 + GESTURE_MS);
      assert.equal(pm(c3).clip, "sit");
    });
  }

  test("les autres transitions ne déclenchent aucun geste (release non merged, agent-add, feature-retry)", () => {
    const others = [
      { kind: "release", id: "r", from: null, to: "open" }, { kind: "agent-add", id: "x", from: null, to: "dev" },
      { kind: "feature-retry", id: 1, from: 0, to: 1 }, { kind: "milestone", id: 1, from: "open", to: "closed" },
    ];
    assert.equal(pm(stepCrew(stepCrew([], empty, [], T), empty, others, T + 10)).clip, "sit");
  });

  test("au plus un geste par seconde : l'excédent est ignoré, sans file", () => {
    const c0 = stepCrew([], empty, [], T);
    const c1 = stepCrew(c0, empty, [kinds["feature-move"]], T);
    const c2 = stepCrew(c1, empty, [kinds["feature-status"], kinds["release merged"]], T + 400);
    assert.equal(pm(c2).gestureAt, T, "le geste en cours n'est pas relancé");
    const c3 = stepCrew(c2, empty, [], T + GESTURE_MS);
    assert.equal(pm(c3).clip, "sit", "pas de geste en file d'attente");
    const c4 = stepCrew(c3, empty, [], T + 5 * GESTURE_MS);
    assert.equal(pm(c4).clip, "sit");
    const c5 = stepCrew(c4, empty, [kinds["feature-status"]], T + 6 * GESTURE_MS);
    assert.equal(pm(c5).clip, "interact-right", "un nouveau geste est accepté après une seconde");
  });

  test("le geste est indépendant des agents : il ne change ni leurs états ni leurs places", () => {
    const m = model(DEV("d1"));
    const a = stepCrew(stepCrew([], m, [], T), m, [], T + 500);
    const b = stepCrew(stepCrew([], m, [], T), m, [kinds["feature-move"]], T + 500);
    assert.deepEqual(team(a), team(b));
  });
});

describe("mode réduit, état par état", () => {
  const R = (crew, ...agents) => stepCrew(crew, model(...agents), [], T + 50, true);
  const at = (b, seat) => assert.deepEqual([b.position.x, b.position.z], [seat.x, seat.z]);

  test("running : working au poste, clip figé, sans passage par entering", () => {
    const [b] = stepCrew([], model(DEV("d1", { issue: 5 })), [], T, true);
    assert.equal(b.state, "working");
    assert.equal(b.frozen, true);
    assert.equal(b.clip, "interact-right");
    assert.equal(b.folder.label, "#5");
    at(b, devSeat(0));
  });

  test("reported : reporting au poste avec bulle de 4 s puis assis", () => {
    const a = VER("v1", { verdict: "PASS", phase: "reported" });
    const first = stepCrew([], model(a), [], T, true);
    assert.equal(first[0].state, "reporting");
    assert.equal(first[0].bubble, "PASS");
    at(first[0], seatFor("verification", "verificateur", 0));
    assert.equal(stepCrew(first, model(a), [], T + BUBBLE_MS + 1, true)[0].bubble, null);
  });

  test("unknown : stale avec bulle « ? » au poste", () => {
    const [b] = stepCrew([], model(DEV("d1", { phase: "unknown" })), [], T, true);
    assert.equal(b.state, "stale");
    assert.equal(b.bubble, "?");
    at(b, devSeat(0));
  });

  test("finished : gone à la porte, et reprise directe au poste", () => {
    const [g] = stepCrew([], model(DEV("d1", { phase: "finished" })), [], T, true);
    assert.equal(g.state, "gone");
    const back = R([g], DEV("d1"));
    assert.equal(back[0].state, "working");
    at(back[0], devSeat(0));
    const out = R(back, DEV("d1", { phase: "finished" }));
    assert.equal(out[0].state, "gone");
  });

  test("passer en mode réduit pendant une marche pose le bonhomme à destination", () => {
    const first = stepCrew([], model(DEV("d1")), [], T);
    const mid = stepCrew(first, model(DEV("d1")), [], T + 500);
    assert.equal(mid[0].state, "entering");
    const r = stepCrew(mid, model(DEV("d1")), [], T + 600, true);
    assert.equal(r[0].state, "working");
    at(r[0], devSeat(0));
  });

  test("hors mode réduit, les clips ne sont pas figés", () => {
    assert.equal(stepCrew([], model(DEV("d1")), [], T)[0].frozen, false);
  });
});
