// Tests unitaires de viz/public/js/layout.js : stations, zone d'escalade, files de features (100 features dans une
// station), positions des agents, déterminisme. Le module est pur : aucun DOM, aucun WebGL.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { init, STATIONS } from "../../viz/public/js/state.js";
import {
  LAYOUT,
  stationBox,
  stationBoxes,
  escaladeBox,
  escaladeBoxes,
  boxContains,
  layoutFeatures,
  layoutAgents,
  layoutScene,
} from "../../viz/public/js/layout.js";
import { at, feature, agent, stateOf, M1, M2 } from "./support.mjs";

const range = (n, start = 1) => Array.from({ length: n }, (_, i) => start + i);
const key = (p) => `${p.x}|${p.y}|${p.z}`;

function modelWith(features, agents = []) {
  return init(stateOf({ features, agents }));
}

describe("stations", () => {
  test("7 stations ordonnées de gauche à droite sur l'axe x, à la même profondeur", () => {
    const boxes = stationBoxes();
    assert.deepEqual(boxes.map((b) => b.id), ["cadrage", "roadmap", "dev", "verification", "test", "merge", "release"]);
    assert.deepEqual(boxes.map((b) => b.id), [...STATIONS]);
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].x > boxes[i - 1].x, "x strictement croissant");
    assert.ok(boxes.every((b) => b.z === 0 && b.y === 0));
    assert.ok(boxes.every((b, i) => b.index === i));
  });

  test("les boîtes sont espacées régulièrement, sans chevauchement, et centrées sur l'origine", () => {
    const boxes = stationBoxes();
    const steps = boxes.slice(1).map((b, i) => b.x - boxes[i].x);
    assert.ok(steps.every((s) => s === steps[0]));
    assert.ok(steps[0] >= LAYOUT.stationWidth + 1, "un espace sépare deux stations");
    assert.equal(boxes.reduce((sum, b) => sum + b.x, 0), 0);
    assert.equal(boxes[3].x, 0);
  });

  test("les positions sont fixes : deux appels donnent le même résultat, et l'identifiant inconnu donne null", () => {
    assert.deepEqual(stationBoxes(), stationBoxes());
    assert.deepEqual(stationBox("dev"), stationBoxes()[2]);
    assert.equal(stationBox("escalade"), null);
    assert.equal(stationBox("nimporte"), null);
    assert.equal(escaladeBox("nimporte"), null);
  });
});

describe("zone d'escalade", () => {
  test("une zone par station, derrière elle, sans chevaucher la station ni ses voisines", () => {
    const zones = escaladeBoxes();
    assert.equal(zones.length, 7);
    for (const zone of zones) {
      const station = stationBox(zone.station);
      assert.equal(zone.id, "escalade");
      assert.equal(zone.x, station.x);
      assert.ok(zone.z + zone.depth / 2 < station.z - station.depth / 2, "derrière la station (z négatif)");
    }
    for (let i = 1; i < zones.length; i++) assert.ok(zones[i].x - zones[i - 1].x >= zones[i].width, "pas de chevauchement");
  });

  test("une feature bloquée est rangée dans la zone d'escalade de sa station d'accolement", () => {
    const model = modelWith([feature(1, "blocked", { station: "test" }), feature(2, "in-test"), feature(3, "blocked")]);
    const positions = layoutFeatures(model);
    const p1 = positions.get(1);
    const p2 = positions.get(2);
    const p3 = positions.get(3);
    assert.deepEqual([p1.zone, p1.station], ["escalade", "test"]);
    assert.ok(boxContains(escaladeBox("test"), p1));
    assert.ok(!boxContains(stationBox("test"), p1));
    assert.deepEqual([p2.zone, p2.station], ["station", "test"]);
    assert.ok(boxContains(stationBox("test"), p2));
    // Sans station d'accolement connue, la zone de dev.
    assert.deepEqual([p3.zone, p3.station], ["escalade", "dev"]);
    assert.ok(boxContains(escaladeBox("dev"), p3));
  });

  test("100 features bloquées tiennent dans la zone d'escalade, à des positions distinctes", () => {
    const model = modelWith(range(100).map((n) => feature(n, "blocked", { station: "verification" })));
    const points = [...layoutFeatures(model).values()];
    assert.equal(new Set(points.map(key)).size, 100);
    assert.ok(points.every((p) => boxContains(escaladeBox("verification"), p)));
  });
});

describe("files de features", () => {
  test("100 features dans une même station : aucune paire de positions identique, toutes dans la boîte", () => {
    const model = modelWith(range(100).map((n) => feature(n, "in-progress")));
    const positions = layoutFeatures(model);
    assert.equal(positions.size, 100);
    const points = [...positions.values()];
    assert.equal(new Set(points.map(key)).size, 100, "positions toutes distinctes");
    const box = stationBox("dev");
    for (const p of points) assert.ok(boxContains(box, p), `hors de la boîte : ${key(p)}`);
    // Avec la marge intérieure, le centre d'une cellule reste au moins à une demi-cellule du bord.
    for (const p of points) {
      assert.ok(Math.abs(p.x - box.x) <= box.width / 2 - LAYOUT.cell / 2);
      assert.ok(Math.abs(p.z - box.z) <= box.depth / 2 - LAYOUT.cell / 2);
    }
  });

  test("100 features dans chacune des stations : positions distinctes sur toute la scène", () => {
    const features = [];
    for (const [i, status] of ["ready", "in-progress", "in-review", "in-test", "done"].entries()) {
      for (const n of range(100, 1000 * (i + 1))) features.push(feature(n, status));
    }
    const positions = layoutFeatures(modelWith(features));
    assert.equal(positions.size, 500);
    assert.equal(new Set([...positions.values()].map(key)).size, 500);
    for (const p of positions.values()) assert.ok(boxContains(stationBox(p.station), p));
  });

  test("une file saturée empile des couches puis resserre les lignes, sans jamais sortir de la boîte ni se superposer", () => {
    const box = stationBox("dev");
    const capacityOneLayer = 13 * 11;
    const full = layoutFeatures(modelWith(range(capacityOneLayer + 1).map((n) => feature(n, "in-progress"))));
    assert.deepEqual([full.get(capacityOneLayer).layer, full.get(capacityOneLayer + 1).layer], [0, 1]);
    assert.ok(full.get(capacityOneLayer + 1).y > full.get(1).y);

    for (const count of [300, 1000]) {
      const points = [...layoutFeatures(modelWith(range(count).map((n) => feature(n, "in-progress")))).values()];
      assert.equal(new Set(points.map(key)).size, count, `${count} features`);
      for (const p of points) assert.ok(boxContains(box, p), `${count} features : hors de la boîte`);
    }
  });

  test("grille triée par numéro, remplie ligne par ligne", () => {
    const positions = layoutFeatures(modelWith([feature(30, "ready"), feature(2, "ready"), feature(11, "ready")]));
    const order = [...positions.entries()].sort(([, a], [, b]) => a.row - b.row || a.col - b.col).map(([n]) => n);
    assert.deepEqual(order, [2, 11, 30]);
    assert.deepEqual([2, 11, 30].map((n) => [positions.get(n).row, positions.get(n).col]), [[0, 0], [0, 1], [0, 2]]);
    assert.ok(Math.abs(positions.get(11).x - positions.get(2).x - LAYOUT.cell) < 1e-9);
  });

  test("passe à la ligne après la dernière colonne", () => {
    const positions = layoutFeatures(modelWith(range(14).map((n) => feature(n, "ready"))));
    assert.deepEqual([positions.get(13).row, positions.get(13).col], [0, 12]);
    assert.deepEqual([positions.get(14).row, positions.get(14).col], [1, 0]);
    assert.equal(positions.get(14).x, positions.get(1).x);
    assert.ok(positions.get(14).z < positions.get(1).z, "la ligne suivante est plus loin du spectateur");
  });

  test("regroupe par milestone (dans l'ordre des milestones), chaque groupe sur une nouvelle ligne, puis les features sans milestone", () => {
    const model = modelWith([
      feature(1, "ready", { milestone: M2 }),
      feature(2, "ready", { milestone: M1 }),
      feature(3, "ready", { milestone: M1 }),
      feature(4, "ready", { milestone: null }),
      feature(5, "ready", { milestone: M2 }),
      feature(6, "ready", { milestone: "Milestone inconnu" }),
    ]);
    const p = layoutFeatures(model);
    const cell = (n) => [p.get(n).row, p.get(n).col];
    assert.deepEqual([2, 3].map(cell), [[0, 0], [0, 1]]);
    assert.deepEqual([1, 5].map(cell), [[1, 0], [1, 1]]);
    assert.deepEqual([4, 6].map(cell), [[2, 0], [2, 1]]);
  });

  test("un groupe qui déborde d'une ligne fait commencer le suivant sur une ligne vierge", () => {
    const m1 = range(14).map((n) => feature(n, "ready", { milestone: M1 }));
    const m2 = [feature(100, "ready", { milestone: M2 })];
    const p = layoutFeatures(modelWith([...m1, ...m2]));
    assert.deepEqual([p.get(14).row, p.get(14).col], [1, 0]);
    assert.deepEqual([p.get(100).row, p.get(100).col], [2, 0]);
  });

  test("une feature ne bouge pas quand les autres stations changent, ni quand on ajoute un numéro plus grand dans sa file", () => {
    const base = [feature(1, "in-progress"), feature(2, "in-progress")];
    const before = layoutFeatures(modelWith(base));
    const withOthers = layoutFeatures(modelWith([...base, feature(3, "ready"), feature(4, "in-review"), feature(9, "in-progress")]));
    for (const n of [1, 2]) assert.deepEqual(withOthers.get(n), before.get(n));
  });

  test("est déterministe et indépendant de l'ordre des tableaux en entrée", () => {
    const features = range(40).map((n) => feature(n, ["ready", "in-progress", "blocked"][n % 3], { milestone: n % 2 ? M1 : M2 }));
    const a = layoutFeatures(modelWith(features));
    const b = layoutFeatures(modelWith(features));
    const c = layoutFeatures(modelWith([...features].reverse()));
    assert.deepEqual([...a], [...b]);
    assert.deepEqual([...a].sort(([x], [y]) => x - y), [...c].sort(([x], [y]) => x - y));
  });

  test("les features d'un milestone fermé sont rangées à Release", () => {
    const model = init(stateOf({ milestones: [{ number: 1, title: M1, state: "closed", total: 0, done: 0 }], features: [feature(1, "done"), feature(2, "in-progress")] }));
    const p = layoutFeatures(model);
    assert.deepEqual([p.get(1).station, p.get(2).station], ["release", "release"]);
    assert.ok(boxContains(stationBox("release"), p.get(1)));
  });

  test("un modèle vide ne donne aucune position", () => {
    assert.equal(layoutFeatures(modelWith([])).size, 0);
  });
});

describe("agents", () => {
  test("un agent est placé au-dessus de la feature qu'il traite", () => {
    const model = modelWith([feature(5, "in-progress"), feature(6, "in-progress")], [agent("a", { issue: 6 })]);
    const features = layoutFeatures(model);
    const p = layoutAgents(model, features).get("a");
    const f = features.get(6);
    assert.deepEqual([p.x, p.z, p.anchor, p.feature], [f.x, f.z, "feature", 6]);
    assert.equal(p.y, f.y + LAYOUT.agentOverFeature);
  });

  test("plusieurs agents sur la même feature sont empilés", () => {
    const model = modelWith([feature(5, "in-review")], [agent("a", { issue: 5, since: at(1) }), agent("b", { issue: 5, since: at(2), type: "verificateur", station: "verification" })]);
    const out = layoutAgents(model);
    assert.ok(out.get("b").y > out.get("a").y);
    assert.equal(out.get("b").y - out.get("a").y, LAYOUT.agentStack);
    assert.equal(out.get("a").x, out.get("b").x);
  });

  test("l'agent d'une feature en zone d'escalade la survole", () => {
    const model = modelWith([feature(5, "blocked", { station: "test" })], [agent("a", { issue: 5, type: "architecte", mode: "ESCALADE", station: "escalade" })]);
    const features = layoutFeatures(model);
    const p = layoutAgents(model, features).get("a");
    assert.equal(p.anchor, "feature");
    assert.equal(p.z, features.get(5).z);
    assert.ok(p.z < 0);
  });

  test("sans feature affichée, l'agent survole sa station, répartis sans sortir de la largeur de la boîte", () => {
    const box = stationBox("verification");
    for (const count of [1, 3, 20]) {
      const agents = range(count).map((n) => agent(`v${n}`, { station: "verification", type: "verificateur", since: at(n) }));
      const out = layoutAgents(modelWith([], agents));
      const points = [...out.values()];
      assert.equal(new Set(points.map(key)).size, count, `${count} agents distincts`);
      for (const p of points) {
        assert.equal(p.anchor, "station");
        assert.ok(p.y > box.height, "au-dessus de la boîte");
        assert.ok(Math.abs(p.x - box.x) <= box.width / 2);
        assert.equal(p.z, box.z);
      }
    }
  });

  test("un agent dont l'issue n'est pas affichée retombe sur sa station", () => {
    const out = layoutAgents(modelWith([], [agent("a", { issue: 99, station: "test", type: "testeur" })]));
    assert.equal(out.get("a").anchor, "station");
    assert.equal(out.get("a").x, stationBox("test").x);
  });

  test("l'architecte d'escalade sans feature survole le milieu de la rangée des zones d'escalade", () => {
    const out = layoutAgents(modelWith([], [agent("a", { type: "architecte", mode: "ESCALADE", station: "escalade" })]));
    const p = out.get("a");
    assert.deepEqual([p.anchor, p.x, p.z], ["escalade", 0, escaladeBox("dev").z]);
    assert.ok(p.y > LAYOUT.stationHeight);
  });

  test("l'architecte de cadrage et de revue de roadmap survole Cadrage et Roadmap", () => {
    const out = layoutAgents(
      modelWith([], [
        agent("c", { type: "architecte", mode: "CADRAGE_INITIAL", station: "cadrage" }),
        agent("r", { type: "architecte", mode: "REVUE_ROADMAP", station: "roadmap", since: at(1) }),
      ]),
    );
    assert.equal(out.get("c").x, stationBox("cadrage").x);
    assert.equal(out.get("r").x, stationBox("roadmap").x);
  });

  test("un agent sans station connue attend à gauche de la première station", () => {
    const out = layoutAgents(modelWith([], [agent("a", { station: null, type: "inconnu" }), agent("b", { station: null, type: "inconnu", since: at(1) })]));
    const first = stationBox("cadrage");
    for (const p of out.values()) {
      assert.equal(p.anchor, "none");
      assert.ok(p.x < first.x - first.width / 2);
    }
    assert.notEqual(key(out.get("a")), key(out.get("b")));
  });

  test("est déterministe et indépendant de l'ordre des agents", () => {
    const agents = range(6).map((n) => agent(`d${n}`, { station: "dev", since: at(n % 3) }));
    const a = layoutAgents(modelWith([], agents));
    const b = layoutAgents(modelWith([], [...agents].reverse()));
    assert.deepEqual([...a].sort(([x], [y]) => (x < y ? -1 : 1)), [...b].sort(([x], [y]) => (x < y ? -1 : 1)));
  });
});

describe("layoutScene", () => {
  test("réunit stations, zones d'escalade, features et agents", () => {
    const model = modelWith([feature(1, "in-progress"), feature(2, "blocked")], [agent("a", { issue: 1 })]);
    const scene = layoutScene(model);
    assert.equal(scene.stations.length, 7);
    assert.equal(scene.escalades.length, 7);
    assert.deepEqual([...scene.features.keys()], [1, 2]);
    assert.deepEqual([...scene.agents.keys()], ["a"]);
    assert.deepEqual(scene, layoutScene(model));
  });
});
