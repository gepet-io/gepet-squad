// Tests de viz/public/js/view-model.js : couleurs des statuts, correspondance instance -> feature, lissage, cadrage,
// repli texte. Module pur, importé sans DOM.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { init } from "../../viz/public/js/state.js";
import { layoutFeatures, stationBoxes, escaladeBoxes } from "../../viz/public/js/layout.js";
import {
  STATUS_COLORS,
  STATUS_LABELS,
  UNKNOWN_COLOR,
  approach,
  capacityFor,
  colorCss,
  fallbackGroups,
  featureForInstance,
  featureInstances,
  featureLabel,
  fitCamera,
  legendEntries,
  sceneBounds,
  stationName,
  statusColor,
  stepPositions,
  toNdc,
} from "../../viz/public/js/view-model.js";
import { feature, stateOf, M1, M2, milestone } from "./support.mjs";

const modelOf = (features, extra = {}) => init(stateOf({ features, ...extra }));
const instancesOf = (model) => featureInstances(model, layoutFeatures(model));

describe("couleurs des statuts", () => {
  // Palette de skills/gepet-squad/references/github-conventions.md : la source de vérité est ce fichier.
  const conventions = fs.readFileSync(new URL("../../skills/gepet-squad/references/github-conventions.md", import.meta.url), "utf8");

  test("chaque statut a la couleur de son label `status:*` dans github-conventions.md", () => {
    const statuses = Object.keys(STATUS_COLORS);
    assert.equal(statuses.length, 8);
    for (const status of statuses) {
      const row = new RegExp(`\\|\\s*\`status:${status}\`\\s*\\|[^|]*\\|\\s*\`(#[0-9a-f]{6})\`\\s*\\|`).exec(conventions);
      assert.ok(row, `status:${status} introuvable dans github-conventions.md`);
      assert.equal(colorCss(statusColor(status)), row[1], `couleur de ${status}`);
    }
  });

  test("tous les statuts connus de state.js ont une couleur et un libellé", async () => {
    const { STATUSES } = await import("../../viz/public/js/state.js");
    for (const status of STATUSES) {
      assert.notEqual(statusColor(status), UNKNOWN_COLOR, `couleur manquante pour ${status}`);
      assert.ok(STATUS_LABELS[status], `libellé manquant pour ${status}`);
    }
  });

  test("un statut inconnu (ou un nom hérité d'Object) reçoit le gris neutre", () => {
    for (const status of ["nope", "", undefined, null, "constructor", "__proto__", "toString"]) {
      assert.equal(statusColor(status), UNKNOWN_COLOR, String(status));
    }
  });

  test("colorCss écrit #rrggbb sur 6 chiffres", () => {
    assert.equal(colorCss(0x0e8a16), "#0e8a16");
    assert.equal(colorCss(0x000001), "#000001");
    assert.equal(colorCss(0xffffff), "#ffffff");
  });

  test("la légende liste les statuts dans l'ordre de la palette", () => {
    const entries = legendEntries();
    assert.deepEqual(entries.map((e) => e.status), Object.keys(STATUS_COLORS));
    assert.ok(entries.every((e) => /^#[0-9a-f]{6}$/.test(e.css) && e.label.length > 0));
  });
});

describe("noms et libellés", () => {
  test("stationName : les 7 stations, l'escalade, et un identifiant inconnu tel quel", () => {
    assert.equal(stationName("dev"), "Développement");
    assert.equal(stationName("verification"), "Vérification");
    assert.equal(stationName("escalade"), "Escalade");
    assert.equal(stationName("inconnue"), "inconnue");
    assert.equal(stationName("constructor"), "constructor");
  });

  test("featureLabel : numéro et titre, titre vide ou absent -> numéro seul, HTML laissé tel quel", () => {
    assert.equal(featureLabel({ number: 12, title: "Afficher le pipeline" }), "#12 Afficher le pipeline");
    assert.equal(featureLabel({ number: 12, title: null }), "#12");
    assert.equal(featureLabel({ number: 12, title: "" }), "#12");
    const html = '<img src=x onerror="alert(1)">';
    assert.equal(featureLabel({ number: 3, title: html }), `#3 ${html}`);
  });
});

describe("featureInstances et featureForInstance (instance -> feature)", () => {
  const model = modelOf([
    feature(30, "in-review", { title: "Trois" }),
    feature(10, "ready", { title: "Un" }),
    feature(20, "blocked", { title: "Deux" }),
    feature(40, "done", { title: "Quatre" }),
  ]);

  test("les instances sont triées par numéro et portent la couleur de leur statut", () => {
    const instances = instancesOf(model);
    assert.deepEqual(instances.map((i) => i.number), [10, 20, 30, 40]);
    assert.deepEqual(instances.map((i) => i.color), [
      STATUS_COLORS.ready,
      STATUS_COLORS.blocked,
      STATUS_COLORS["in-review"],
      STATUS_COLORS.done,
    ]);
  });

  test("chaque instance porte la position et la station calculées par layout.js", () => {
    const positions = layoutFeatures(model);
    for (const instance of featureInstances(model, positions)) {
      const p = positions.get(instance.number);
      assert.deepEqual(instance.position, { x: p.x, y: p.y, z: p.z });
      assert.equal(instance.station, p.station);
      assert.equal(instance.zone, p.zone);
    }
  });

  test("une feature bloquée est dans la zone d'escalade, les autres dans leur station", () => {
    const byNumber = Object.fromEntries(instancesOf(model).map((i) => [i.number, i]));
    assert.equal(byNumber[20].zone, "escalade");
    assert.equal(byNumber[20].escalated, true);
    assert.equal(byNumber[30].zone, "station");
    assert.equal(byNumber[30].station, "verification");
    assert.equal(byNumber[10].station, "roadmap");
  });

  test("featureForInstance rend la feature de l'instance, et null hors plage ou pour un id invalide", () => {
    const instances = instancesOf(model);
    assert.equal(featureForInstance(instances, 0).number, 10);
    assert.equal(featureForInstance(instances, 2).title, "Trois");
    assert.equal(featureForInstance(instances, 3).number, 40);
    for (const id of [4, -1, 1.5, NaN, undefined, null, "1"]) assert.equal(featureForInstance(instances, id), null, String(id));
    assert.equal(featureForInstance([], 0), null);
  });

  test("une feature sans place dans le layout n'est pas une instance", () => {
    const positions = layoutFeatures(model);
    positions.delete(30);
    assert.deepEqual(featureInstances(model, positions).map((i) => i.number), [10, 20, 40]);
  });

  test("un changement de statut change la couleur et la station de l'instance (la même feature, un autre emplacement)", () => {
    const before = instancesOf(modelOf([feature(5, "in-progress")]))[0];
    const after = instancesOf(modelOf([feature(5, "in-review")]))[0];
    assert.equal(before.station, "dev");
    assert.equal(after.station, "verification");
    assert.notEqual(before.color, after.color);
    assert.ok(after.position.x > before.position.x, "verification est à droite de dev");
  });
});

describe("lissage des déplacements", () => {
  test("approach se rapproche sans dépasser, plus vite avec dt, et se cale sur la cible", () => {
    const a = approach(0, 10, 0.1);
    assert.ok(a > 0 && a < 10);
    assert.ok(approach(0, 10, 0.5) > a);
    assert.ok(approach(0, 10, 10) <= 10);
    assert.equal(approach(0, 10, 10), 10);
    assert.equal(approach(3, 10, 0), 3, "dt nul : pas de mouvement");
    assert.equal(approach(3, 10, -1), 3, "dt négatif traité comme nul");
    assert.equal(approach(9.999, 10, 0), 10, "assez proche : on se cale");
    assert.ok(approach(10, 0, 0.1) < 10, "fonctionne dans les deux sens");
  });

  test("une feature nouvelle apparaît à sa place, une feature disparue est retirée", () => {
    const targets = new Map([[1, { x: 5, y: 1, z: 2 }]]);
    const { positions, moving } = stepPositions(new Map([[9, { x: 0, y: 0, z: 0 }]]), targets, 0.016);
    assert.deepEqual([...positions.keys()], [1]);
    assert.deepEqual(positions.get(1), { x: 5, y: 1, z: 2 });
    assert.equal(moving, false);
  });

  test("une feature dont la cible change se déplace jusqu'à l'arrivée en moins de 3 s", () => {
    let current = new Map([[1, { x: 0, y: 0.6, z: 0 }]]);
    const targets = new Map([[1, { x: 26, y: 0.6, z: 3 }]]);
    let time = 0;
    let moving = true;
    let first = true;
    while (moving && time < 10) {
      const step = stepPositions(current, targets, 1 / 60);
      if (first) {
        assert.ok(step.moving);
        const p = step.positions.get(1);
        assert.ok(p.x > 0 && p.x < 26, "en cours de route après une image");
        first = false;
      }
      current = step.positions;
      moving = step.moving;
      time += 1 / 60;
    }
    assert.equal(moving, false);
    assert.ok(time < 3, `arrivée en ${time.toFixed(2)} s`);
    assert.deepEqual(current.get(1), { x: 26, y: 0.6, z: 3 });
  });

  test("ne modifie pas les positions reçues", () => {
    const from = { x: 0, y: 0, z: 0 };
    const currents = new Map([[1, from]]);
    stepPositions(currents, new Map([[1, { x: 10, y: 0, z: 0 }]]), 0.1);
    assert.deepEqual(from, { x: 0, y: 0, z: 0 });
    assert.equal(currents.get(1), from);
  });
});

describe("capacité de l'InstancedMesh", () => {
  test("minimum 64, puissance de 2 suivante, capacité conservée tant qu'elle suffit", () => {
    assert.equal(capacityFor(0), 64);
    assert.equal(capacityFor(1), 64);
    assert.equal(capacityFor(64), 64);
    assert.equal(capacityFor(65), 128);
    assert.equal(capacityFor(1000), 1024);
    assert.equal(capacityFor(10, 256), 256, "ne rétrécit pas");
    assert.equal(capacityFor(300, 256), 512, "grandit quand il le faut");
    assert.equal(capacityFor(0, 0), 64);
  });
});

describe("géométrie de la vue", () => {
  test("toNdc : centre, coins, décalage du rectangle, canvas vide", () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    assert.deepEqual(toNdc(300, 150, rect), { x: 0, y: 0 });
    assert.deepEqual(toNdc(100, 50, rect), { x: -1, y: 1 });
    assert.deepEqual(toNdc(500, 250, rect), { x: 1, y: -1 });
    assert.equal(toNdc(1, 1, { left: 0, top: 0, width: 0, height: 10 }), null);
    assert.equal(toNdc(1, 1, { left: 0, top: 0, width: 10, height: 0 }), null);
    assert.equal(toNdc(1, 1, null), null);
  });

  const boxes = [...stationBoxes(), ...escaladeBoxes()];

  test("sceneBounds couvre toutes les boîtes (7 stations de 18 + 6 écarts de 8 = 174 de large)", () => {
    const b = sceneBounds(boxes);
    assert.equal(b.maxX - b.minX, 174);
    assert.equal(b.minX, -b.maxX, "centrée sur x = 0");
    assert.equal(b.maxZ, 8, "avant des stations");
    assert.equal(b.minZ, -(8 + 3 + 8), "arrière des zones d'escalade");
    assert.equal(b.height, 6);
    for (const box of boxes) {
      assert.ok(box.x - box.width / 2 >= b.minX && box.x + box.width / 2 <= b.maxX);
      assert.ok(box.z - box.depth / 2 >= b.minZ && box.z + box.depth / 2 <= b.maxZ);
    }
  });

  test("fitCamera : vise le centre de l'emprise, au-dessus et devant, et tout tient dans le champ", () => {
    const bounds = sceneBounds(boxes);
    const options = { fov: 45, aspect: 16 / 9 };
    const view = fitCamera(bounds, options);
    assert.equal(view.target.x, 0);
    assert.equal(view.target.z, (bounds.minZ + bounds.maxZ) / 2);
    assert.ok(view.position.y > view.target.y, "au-dessus");
    assert.ok(view.position.z > bounds.maxZ, "devant");
    // La demi-largeur de l'emprise tient dans le demi-champ horizontal à cette distance.
    const tanH = Math.tan((options.fov * Math.PI) / 360) * options.aspect;
    assert.ok(bounds.maxX / tanH <= view.distance, `largeur visible (${bounds.maxX / tanH} <= ${view.distance})`);
    const distance = Math.hypot(view.position.x - view.target.x, view.position.y - view.target.y, view.position.z - view.target.z);
    assert.ok(Math.abs(distance - view.distance) < 1e-9);
  });

  test("fitCamera : une fenêtre plus étroite recule la caméra", () => {
    const bounds = sceneBounds(boxes);
    assert.ok(fitCamera(bounds, { aspect: 0.8 }).distance > fitCamera(bounds, { aspect: 2.4 }).distance);
  });

  test("fitCamera : une emprise minuscule ne place pas la caméra sur la cible", () => {
    const bounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, height: 1 };
    assert.ok(fitCamera(bounds).distance >= 10);
  });
});

describe("repli texte", () => {
  test("toutes les stations sont listées dans l'ordre, les features à leur place, l'escalade à part", () => {
    const model = modelOf(
      [
        feature(1, "ready", { title: "Prête" }),
        feature(2, "in-progress", { title: "En cours" }),
        feature(3, "blocked", { title: "Bloquée" }),
        feature(4, "done", { title: "<b>gras</b>" }),
      ],
      { milestones: [milestone(1, M1), milestone(2, M2)] },
    );
    const groups = fallbackGroups(model);
    assert.deepEqual(groups.map((g) => g.id), ["cadrage", "roadmap", "dev", "verification", "test", "merge", "release", "escalade"]);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    assert.deepEqual(byId.roadmap.features.map((f) => f.number), [1]);
    assert.deepEqual(byId.dev.features.map((f) => f.number), [2], "la feature bloquée n'est plus dans sa station");
    assert.deepEqual(byId.escalade.features.map((f) => f.number), [3]);
    assert.equal(byId.merge.features[0].text, "#4 <b>gras</b>", "texte brut, jamais interprété");
    assert.equal(byId.dev.features[0].status, "En cours");
    assert.deepEqual(byId.cadrage.features, []);
  });

  test("sans feature bloquée, pas de groupe d'escalade", () => {
    const groups = fallbackGroups(modelOf([feature(1, "ready")]));
    assert.equal(groups.length, 7);
    assert.equal(groups.some((g) => g.id === "escalade"), false);
  });
});
