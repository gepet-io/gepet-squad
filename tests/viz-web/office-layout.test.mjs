// Tests de viz/public/js/office-layout.js : zones, postes de développeur, places par station, points de passage sans
// collision, kanban (tri, plafond), déterminisme, pureté, et cohérence avec le manifeste d'assets.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { init, STATIONS, ESCALADE } from "../../viz/public/js/state.js";
import { ASSETS } from "../../viz/public/js/assets.js";
import {
  OFFICE,
  MAX_DEV_SEATS,
  DEFAULT_DEV_SEATS,
  MAX_ZONE_SEATS,
  KANBAN_MAX_PER_COLUMN,
  KANBAN_COLUMNS,
  devSeat,
  seatFor,
  waypoints,
  allFurniture,
  kanbanLayout,
} from "../../viz/public/js/office-layout.js";
import { assertPure, feature, milestone, stateOf, M1, M2 } from "./support.mjs";

const range = (n, start = 1) => Array.from({ length: n }, (_, i) => start + i);
const SEATED_STATIONS = ["cadrage", "roadmap", "verification", "test", "escalade"];
const EPS = 1e-9;

// Les intérieurs des boîtes (3D) se recoupent-ils ? Le contact ne compte pas (écran posé sur son bureau).
const overlap3d = (a, b) =>
  a.minX < b.maxX - EPS && b.minX < a.maxX - EPS && a.minY < b.maxY - EPS && b.minY < a.maxY - EPS && a.minZ < b.maxZ - EPS && b.minZ < a.maxZ - EPS;
const inXZ = (box, p) => p.x >= box.minX - EPS && p.x <= box.maxX + EPS && p.z >= box.minZ - EPS && p.z <= box.maxZ + EPS;
const insideWalls = (p) => p.x >= OFFICE.walls.minX && p.x <= OFFICE.walls.maxX && p.z >= OFFICE.walls.minZ && p.z <= OFFICE.walls.maxZ;
const boxInsideWalls = (b) => insideWalls({ x: b.minX, z: b.minZ }) && insideWalls({ x: b.maxX, z: b.maxZ });

// Le segment [p, q] traverse-t-il l'intérieur de la boîte (au sol, en vue de dessus) ? Méthode des « slabs ».
function segmentHitsBox(p, q, b) {
  let t0 = 0;
  let t1 = 1;
  for (const [a0, a1, lo, hi] of [[p.x, q.x, b.minX, b.maxX], [p.z, q.z, b.minZ, b.maxZ]]) {
    const d = a1 - a0;
    if (Math.abs(d) < EPS) {
      if (a0 <= lo + EPS || a0 >= hi - EPS) return false;
    } else {
      let ta = (lo - a0) / d;
      let tb = (hi - a0) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 >= t1 - EPS) return false;
    }
  }
  return t0 < t1 - EPS;
}

const allSeats = () => [
  ...range(MAX_DEV_SEATS, 0).map(devSeat),
  ...SEATED_STATIONS.flatMap((s) => range(MAX_ZONE_SEATS, 0).map((r) => seatFor(s, "x", r))),
];

describe("OFFICE", () => {
  test("est gelé en profondeur", () => {
    assert.ok(Object.isFrozen(OFFICE));
    assert.ok(Object.isFrozen(OFFICE.zones.dev));
    assert.ok(Object.isFrozen(OFFICE.furniture[0].box));
    assert.throws(() => {
      "use strict";
      OFFICE.door.x = 0;
    });
  });

  test("décrit la porte, une zone par station, le chef de projet et 3 postes de développeur", () => {
    assert.equal(OFFICE.door.id, "doorway");
    assert.deepEqual(Object.keys(OFFICE.zones).sort(), ["cadrage", "dev", "escalade", "roadmap", "test", "verification"]);
    assert.equal(OFFICE.zones.escalade.tint, "#ff3b30");
    assert.equal(OFFICE.pm.seated, true);
    assert.equal(OFFICE.devSeats.length, DEFAULT_DEV_SEATS);
    assert.equal(DEFAULT_DEV_SEATS, 3);
    assert.equal(MAX_DEV_SEATS, 8);
  });

  test("chaque zone est dans les murs et son poste principal dans sa zone", () => {
    for (const [name, z] of Object.entries(OFFICE.zones)) {
      const box = { minX: z.x - z.width / 2, maxX: z.x + z.width / 2, minZ: z.z - z.depth / 2, maxZ: z.z + z.depth / 2 };
      assert.ok(boxInsideWalls(box), `zone ${name} hors des murs`);
      if (SEATED_STATIONS.includes(name)) {
        for (let r = 0; r < MAX_ZONE_SEATS; r++) assert.ok(inXZ(box, seatFor(name, "x", r)), `${name} rang ${r} hors de sa zone`);
      }
    }
    const dev = OFFICE.zones.dev;
    const devBox = { minX: dev.x - dev.width / 2, maxX: dev.x + dev.width / 2, minZ: dev.z - dev.depth / 2, maxZ: dev.z + dev.depth / 2 };
    for (let i = 0; i < MAX_DEV_SEATS; i++) assert.ok(inXZ(devBox, devSeat(i)), `poste ${i} hors de l'open space`);
  });

  test("le mobilier est dans les murs et ses boîtes sont disjointes", () => {
    const all = allFurniture();
    for (const f of all) assert.ok(boxInsideWalls(f.box), `${f.id} hors des murs`);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        assert.ok(!overlap3d(all[i].box, all[j].box), `${all[i].id}#${i} chevauche ${all[j].id}#${j}`);
      }
    }
  });

  test("le test de chevauchement détecte bien une collision", () => {
    const desk = OFFICE.furniture.find((f) => f.id === "desk").box;
    assert.ok(overlap3d(desk, { ...desk }));
  });
});

describe("devSeat", () => {
  test("renvoie bureau, chaise, écran et clavier pour chaque poste, dans les murs", () => {
    for (let i = 0; i < MAX_DEV_SEATS; i++) {
      const seat = devSeat(i);
      assert.equal(seat.index, i);
      assert.deepEqual(seat.furniture.map((f) => f.id), ["desk", "chairDesk", "computerScreen", "computerKeyboard"]);
      assert.equal(seat.extra, i >= DEFAULT_DEV_SEATS);
      assert.ok(insideWalls(seat) && insideWalls(seat.access));
      seat.furniture.forEach((f) => assert.ok(boxInsideWalls(f.box)));
    }
  });

  test("les postes 0 à 7 ne se chevauchent pas et diffèrent", () => {
    const boxes = range(MAX_DEV_SEATS, 0).flatMap((i) => devSeat(i).furniture.map((f) => ({ i, box: f.box })));
    for (const a of boxes) for (const b of boxes) if (a.i < b.i) assert.ok(!overlap3d(a.box, b.box), `poste ${a.i} chevauche ${b.i}`);
    assert.equal(new Set(range(MAX_DEV_SEATS, 0).map((i) => `${devSeat(i).x}|${devSeat(i).z}`)).size, MAX_DEV_SEATS);
  });

  test("renvoie null hors de 0..MAX_DEV_SEATS - 1", () => {
    assert.equal(devSeat(MAX_DEV_SEATS), null);
    assert.equal(devSeat(100), null);
    assert.equal(devSeat(-1), null);
    assert.equal(devSeat(1.5), null);
    assert.equal(devSeat("1"), null);
  });

  test("le point d'accès est devant la chaise, hors de la chaise et du bureau", () => {
    for (let i = 0; i < MAX_DEV_SEATS; i++) {
      const seat = devSeat(i);
      const desk = seat.furniture.find((f) => f.id === "desk");
      const chair = seat.furniture.find((f) => f.id === "chairDesk");
      assert.ok(!inXZ(chair.box, seat.access) && !inXZ(desk.box, seat.access));
      assert.ok(seat.access.z > chair.z, "devant la chaise, du côté opposé au bureau");
      assert.equal(seat.access.x, chair.x);
      assert.ok(inXZ(chair.box, { x: seat.x, z: seat.z }), "le point assis est sur la chaise");
    }
  });
});

describe("seatFor", () => {
  test("rang 0 de chaque station : place assise ou debout, avec un point d'accès", () => {
    for (const s of SEATED_STATIONS) {
      const seat = seatFor(s, "x", 0);
      assert.equal(seat.station, s);
      assert.equal(seat.rank, 0);
      assert.ok(insideWalls(seat) && insideWalls(seat.access));
    }
    assert.equal(seatFor("roadmap", "architecte", 0).seated, false);
    assert.equal(seatFor("verification", "verificateur", 0).seated, true);
    assert.ok(seatFor("roadmap", "architecte", 0).z < -7, "devant le kanban");
  });

  test("les 3 places d'une station sont distinctes ; les rangs 1 et 2 sont debout, hors de tout meuble et dans les murs", () => {
    const all = allFurniture();
    for (const s of SEATED_STATIONS) {
      const seats = range(MAX_ZONE_SEATS, 0).map((r) => seatFor(s, "x", r));
      assert.equal(new Set(seats.map((p) => `${p.x}|${p.z}`)).size, MAX_ZONE_SEATS, `places confondues dans ${s}`);
      for (const seat of seats.slice(1)) {
        assert.equal(seat.seated, false);
        assert.ok(insideWalls(seat), `${seat.key} hors des murs`);
        for (const f of all) assert.ok(!inXZ(f.box, seat), `${seat.key} dans ${f.id}`);
      }
      for (const seat of seats) for (const f of all) assert.ok(!inXZ(f.box, seat.access), `accès de ${seat.key} dans ${f.id}`);
    }
  });

  test("un rang >= 3 renvoie la dernière place", () => {
    for (const s of SEATED_STATIONS) {
      assert.equal(seatFor(s, "x", 3), seatFor(s, "x", 2));
      assert.equal(seatFor(s, "x", 99), seatFor(s, "x", 2));
    }
  });

  test("un rang absent ou invalide donne le poste principal", () => {
    assert.equal(seatFor("test", "testeur"), seatFor("test", "testeur", 0));
    assert.equal(seatFor("test", "testeur", -2), seatFor("test", "testeur", 0));
    assert.equal(seatFor("test", "testeur", 1.5), seatFor("test", "testeur", 0));
  });

  test("station null : un architecte prend les places de cadrage", () => {
    for (let r = 0; r < 4; r++) assert.equal(seatFor(null, "architecte", r), seatFor("cadrage", "architecte", r));
    assert.equal(seatFor(null, "developpeur", 0), null);
  });

  test("merge, release, dev et stations inconnues : pas d'occupant", () => {
    for (const s of ["merge", "release", "dev", "inconnue", "constructor", undefined]) assert.equal(seatFor(s, "x", 0), null);
  });
});

describe("waypoints", () => {
  const paths = waypoints();

  test("un trajet par poste de développeur et par place de chaque station, plus le chef de projet", () => {
    for (const seat of allSeats()) assert.ok(paths[seat.key], `trajet manquant : ${seat.key}`);
    assert.ok(paths.pm);
  });

  test("chaque trajet part de la porte et finit au point d'accès, sans traverser un meuble", () => {
    const all = allFurniture();
    const targets = [...allSeats(), { key: "pm", access: OFFICE.pm.access }];
    for (const seat of targets) {
      const path = paths[seat.key];
      assert.deepEqual(path[0], { x: OFFICE.door.x, z: OFFICE.door.z });
      assert.deepEqual(path[1], OFFICE.door.entry);
      assert.deepEqual(path.at(-1), seat.access, `fin de ${seat.key}`);
      for (const p of path) assert.ok(insideWalls(p), `${seat.key} sort des murs`);
      for (let i = 1; i < path.length; i++) {
        for (const f of all) assert.ok(!segmentHitsBox(path[i - 1], path[i], f.box), `${seat.key} traverse ${f.id} (segment ${i})`);
      }
    }
  });

  test("le détecteur de collision voit un segment qui traverse un bureau", () => {
    const desk = devSeat(0).furniture[0];
    assert.ok(segmentHitsBox({ x: desk.x - 3, z: desk.z }, { x: desk.x + 3, z: desk.z }, desk.box));
    assert.ok(!segmentHitsBox({ x: desk.x - 3, z: desk.z + 3 }, { x: desk.x + 3, z: desk.z + 3 }, desk.box));
  });
});

describe("kanbanLayout", () => {
  const model = (features, milestones) => init(stateOf({ features, ...(milestones ? { milestones } : {}) }));
  const inColumn = (layout, column) => layout.notes.filter((n) => n.column === column);

  test("colonnes : une par station plus escalade, sur des x croissants distincts", () => {
    assert.deepEqual([...KANBAN_COLUMNS], [...STATIONS, ESCALADE]);
    const xs = OFFICE.kanban.columns.map((c) => c.x);
    assert.deepEqual([...xs].sort((a, b) => a - b), xs);
    assert.equal(new Set(xs).size, 8);
  });

  test("0 feature : rien", () => {
    assert.deepEqual(kanbanLayout(model([])), { notes: [], counters: [] });
  });

  test("1 feature : un post-it dans la colonne de sa station", () => {
    const { notes, counters } = kanbanLayout(model([feature(7, "in-progress")]));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].number, 7);
    assert.equal(notes[0].column, "dev");
    assert.equal(notes[0].x, OFFICE.kanban.columns.find((c) => c.id === "dev").x);
    assert.deepEqual(counters, []);
  });

  test("milestone ouvert de plus petit numéro d'abord, puis les autres par numéro", () => {
    const ms = [milestone(1, M1, "closed"), milestone(2, M2), milestone(3, "M3 — Suite")];
    const fs = [
      feature(5, "in-progress", { milestone: "M3 — Suite" }),
      feature(9, "in-progress", { milestone: M2 }),
      feature(2, "in-progress", { milestone: "M3 — Suite" }),
      feature(8, "in-progress", { milestone: M2 }),
      feature(1, "in-progress", { milestone: null }),
    ];
    const notes = inColumn(kanbanLayout(model(fs, ms)), "dev");
    assert.deepEqual(notes.map((n) => n.number), [8, 9, 1, 2, 5]);
    assert.deepEqual(notes.map((n) => n.row), [0, 1, 2, 3, 4]);
    assert.ok(notes[0].y > notes[1].y, "la première ligne est la plus haute");
  });

  test("sans milestone ouvert : tri par numéro", () => {
    const ms = [milestone(1, M1, "closed")];
    const fs = [feature(3, "in-progress", { milestone: null }), feature(1, "in-progress", { milestone: null })];
    assert.deepEqual(inColumn(kanbanLayout(model(fs, ms)), "dev").map((n) => n.number), [1, 3]);
  });

  test("exactement le plafond : tous les post-its, aucun compteur", () => {
    const layout = kanbanLayout(model(range(KANBAN_MAX_PER_COLUMN).map((n) => feature(n, "in-progress"))));
    assert.equal(layout.notes.length, KANBAN_MAX_PER_COLUMN);
    assert.deepEqual(layout.counters, []);
  });

  test("plafond + 7 : le compteur remplace les post-its en trop, après les plus petits numéros", () => {
    const layout = kanbanLayout(model(range(KANBAN_MAX_PER_COLUMN + 7).reverse().map((n) => feature(n, "in-progress"))));
    assert.deepEqual(layout.notes.map((n) => n.number), range(KANBAN_MAX_PER_COLUMN));
    assert.equal(layout.counters.length, 1);
    assert.equal(layout.counters[0].column, "dev");
    assert.equal(layout.counters[0].extra, 7);
    assert.ok(layout.counters[0].y < layout.notes.at(-1).y, "le compteur est sous le dernier post-it");
  });

  test("une feature escaladée va dans la colonne escalade", () => {
    const m = model([feature(4, "blocked")]);
    assert.equal(m.features[0].escalated, true);
    const { notes } = kanbanLayout(m);
    assert.equal(notes[0].column, ESCALADE);
  });

  test("une feature sans colonne connue n'est pas affichée", () => {
    const m = model([feature(4, "in-progress")]);
    m.features[0].station = null;
    assert.deepEqual(kanbanLayout(m).notes, []);
  });
});

describe("déterminisme et pureté", () => {
  test("mêmes entrées, mêmes sorties, quel que soit l'ordre des features", () => {
    const fs = [feature(3, "in-progress"), feature(1, "in-review"), feature(2, "in-progress", { milestone: M2 })];
    const a = kanbanLayout(init(stateOf({ features: fs })));
    const b = kanbanLayout(init(stateOf({ features: [...fs].reverse() })));
    assert.deepEqual(a, b);
    assert.deepEqual(kanbanLayout(init(stateOf({ features: fs }))), a);
    assert.deepEqual(waypoints(), waypoints());
    assert.deepEqual(devSeat(2), devSeat(2));
    assert.deepEqual(seatFor("verification", "verificateur", 1), seatFor("verification", "verificateur", 1));
  });

  test("ne modifie pas le modèle reçu", () => {
    const m = init(stateOf({ features: [feature(2, "in-progress"), feature(1, "in-progress")] }));
    const before = JSON.stringify(m);
    kanbanLayout(m);
    assert.equal(JSON.stringify(m), before);
  });

  test("assertPure", async () => {
    await assertPure("office-layout.js");
  });
});

describe("intégration : manifeste d'assets.js et état de support.mjs", () => {
  test("chaque meuble placé référence un identifiant du manifeste", () => {
    const ids = new Set(ASSETS.furniture.map((f) => f.id));
    assert.ok(ids.has(OFFICE.door.id));
    for (const f of allFurniture()) assert.ok(ids.has(f.id), `${f.id} absent du manifeste`);
  });

  test("kanbanLayout donne une position ou un compteur pour chaque feature, dans l'ordre attendu", () => {
    const M3 = "M3 — Suite";
    const ms = [milestone(1, M1, "closed"), milestone(2, M2), milestone(3, M3)];
    const fs = [
      feature(1, "backlog", { milestone: M3 }),
      feature(2, "ready", { milestone: M2 }),
      feature(3, "in-review", { milestone: M2 }),
      feature(4, "in-test", { milestone: M3 }),
      feature(5, "done", { milestone: M2 }),
      feature(6, "in-progress", { milestone: M1 }), // milestone fermé : colonne release
      feature(7, "blocked", { milestone: M2 }),
      feature(8, "blocked", { milestone: M3 }),
      feature(9, "ready", { milestone: M2 }), // sera placée en cadrage
      // `dev` déborde de 3 : milestone fermé (impairs) et ouvert M2 (pairs).
      ...range(KANBAN_MAX_PER_COLUMN + 3, 100).map((n) => feature(n, "in-progress", { milestone: n % 2 ? M3 : M2 })),
    ];
    const m = init(stateOf({ milestones: ms, features: fs }));
    m.features.find((f) => f.number === 9).station = "cadrage";
    const layout = kanbanLayout(m);

    const columnOf = new Map(m.features.map((f) => [f.number, f.escalated ? ESCALADE : f.station]));
    const counted = new Map(layout.counters.map((c) => [c.column, c.extra]));
    for (const column of KANBAN_COLUMNS) {
      const members = m.features.filter((f) => columnOf.get(f.number) === column);
      assert.ok(members.length > 0, `colonne ${column} vide dans le jeu d'essai`);
      const shown = layout.notes.filter((n) => n.column === column);
      assert.equal(shown.length + (counted.get(column) ?? 0), members.length, `colonne ${column}`);
      assert.ok(shown.length > 0);
    }
    for (const f of m.features) assert.ok(KANBAN_COLUMNS.includes(columnOf.get(f.number)), `feature ${f.number} sans colonne`);
    assert.deepEqual([...counted], [["dev", 3]]);

    // M2 (milestone ouvert le plus petit) d'abord, puis les autres, chacun par numéro.
    const dev = layout.notes.filter((n) => n.column === "dev").map((n) => n.number);
    assert.deepEqual(dev, [100, 102, 104, 106, 108, 110, 101, 103]);
    assert.deepEqual(layout.notes.filter((n) => n.column === ESCALADE).map((n) => n.number), [7, 8]);
    assert.ok(layout.notes.every((n) => n.z === OFFICE.kanban.z));
  });
});
