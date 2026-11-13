// Tests de viz/public/js/labels.js : noms des zones et des colonnes, compteur « +N », badges de retry, info-bulle au survol, texte uniquement par `textContent`.
// Le graphe Three.js est réel (CSS2DObject, lancer de rayon), le DOM et le moteur de rendu sont factices ; les éléments
// factices lèvent une erreur si l'on écrit dans innerHTML ou outerHTML.
import "./three-register.mjs";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { apply, init } from "../../viz/public/js/state.js";
import { OFFICE, kanbanLayout } from "../../viz/public/js/office-layout.js";
import { retryBadgeText } from "../../viz/public/js/motion.js";
import { ESCALADE_NAME, zoneLabels } from "../../viz/public/js/view-model.js";
import { fakeContainer, fakeElement, fakeLoader, fakeRenderer, fakeWindow } from "./dom-fakes.mjs";
import { evt, feature, stateOf } from "./support.mjs";

let THREE;
let createScene;
let createLabels;
before(async () => {
  THREE = await import("three");
  ({ createScene } = await import("../../viz/public/js/scene.js"));
  ({ createLabels } = await import("../../viz/public/js/labels.js"));
});

const XSS = '<img src=x onerror="document.title=1">';
const notePos = (model, number) => kanbanLayout(model).notes.find((n) => n.number === number);

// Document dont les éléments se laissent retirer comme dans un navigateur : le `removed` de CSS2DObject appelle
// `element instanceof element.ownerDocument.defaultView.Element`.
function removableDocument() {
  const view = { Element: { [Symbol.hasInstance]: () => true } };
  return {
    createElement(tag) {
      return fakeElement(tag, { ownerDocument: { defaultView: view, addEventListener() {}, removeEventListener() {} } });
    },
  };
}
const modelOf = (features) => init(stateOf({ features }));

function setup() {
  const container = fakeContainer(1600, 900);
  const renderer = fakeRenderer({ width: 1600, height: 900 });
  const api = createScene({ container, renderer, window: fakeWindow(1600, 900), loadModel: fakeLoader(THREE) });
  const labelRenderer = {
    domElement: fakeElement("div"),
    sizes: [],
    renders: 0,
    setSize(w, h) {
      labelRenderer.sizes.push([w, h]);
    },
    render() {
      labelRenderer.renders += 1;
    },
  };
  const labels = createLabels(api, { container, document: removableDocument(), labelRenderer });
  return { api, labels, labelRenderer, renderer, container };
}

// Zoome sur une feature et renvoie le point d'écran où elle se trouve.
function aimAt(api, position) {
  api.camera.position.set(position.x, position.y + 12, position.z + 12);
  api.camera.lookAt(position.x, position.y, position.z);
  api.camera.updateMatrixWorld();
  const ndc = new THREE.Vector3(position.x, position.y, position.z).project(api.camera);
  return { clientX: ((ndc.x + 1) / 2) * 1600, clientY: ((1 - ndc.y) / 2) * 900 };
}

const labelObjects = (labels) => labels.group.children.filter((o) => o.isCSS2DObject && o !== labels.tooltip);

describe("noms des zones et des colonnes du kanban", () => {
  test("une étiquette par zone du bureau, avec le nom fourni par view-model.js, dans la zone", () => {
    const { labels } = setup();
    const zones = labelObjects(labels).filter((o) => o.position.z !== OFFICE.kanban.z && /label-(zone|escalade)/.test(o.element.className));
    const expected = zoneLabels(OFFICE).filter((entry) => !entry.id.startsWith("kanban:"));
    assert.deepEqual(zones.map((o) => o.element.textContent), expected.map((e) => e.text));
    assert.ok(expected.map((e) => e.text).includes("Salle de réunion"));
    assert.ok(expected.map((e) => e.text).includes("Open space"));
    zones.forEach((object, index) => {
      const zone = OFFICE.zones[expected[index].id];
      assert.equal(object.position.x, zone.x);
      assert.ok(Math.abs(object.position.z - zone.z) <= zone.depth / 2, `${expected[index].text} est dans sa zone`);
    });
  });

  test("une en-tête par colonne du kanban, dans l'ordre du pipeline puis l'escalade, au-dessus de sa colonne", () => {
    const { labels } = setup();
    const heads = labelObjects(labels).filter((o) => o.element.className.includes("label-station") || (o.element.className.includes("label-escalade") && o.position.z === OFFICE.kanban.z));
    assert.deepEqual(heads.map((o) => o.element.textContent), [
      "Cadrage",
      "Roadmap",
      "Développement",
      "Vérification",
      "Test",
      "Merge",
      "Release",
      ESCALADE_NAME,
    ]);
    OFFICE.kanban.columns.forEach((column, index) => {
      assert.equal(heads[index].position.x, column.x);
      assert.ok(heads[index].position.y > OFFICE.kanban.top, "au-dessus du premier post-it");
    });
    assert.ok(heads[7].element.className.includes("label-escalade"), "la colonne d'escalade est signalée en rouge");
  });

  test("les étiquettes sont dans la scène, la couche d'étiquettes dans le conteneur, avec sa classe CSS", () => {
    const { api, labels, labelRenderer, container } = setup();
    assert.ok(api.scene.children.includes(labels.group));
    assert.ok(container.children.includes(labelRenderer.domElement));
    assert.equal(labelRenderer.domElement.className, "labels");
    assert.deepEqual(labelRenderer.sizes.at(-1), [1600, 900]);
  });

  test("la couche d'étiquettes est rendue à chaque image et suit le redimensionnement", () => {
    const { api, labelRenderer } = setup();
    api.frame(1000);
    api.frame(1016);
    assert.equal(labelRenderer.renders, 2);
    api.resize(500, 400);
    assert.deepEqual(labelRenderer.sizes.at(-1), [500, 400]);
  });
});

describe("info-bulle au survol d'un post-it", () => {
  const model = modelOf([
    feature(1, "ready", { title: "Première" }),
    feature(2, "in-progress", { title: "Deuxième" }),
    feature(3, "in-review", { title: XSS }),
  ]);
  const tooltipText = (labels) => labels.tooltip.element.textContent;

  test("l'info-bulle est masquée au départ, et affiche « #numéro titre » sous le pointeur", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    assert.equal(labels.tooltip.visible, false);

    const point = aimAt(api, notePos(model, 2));
    renderer.domElement.dispatch("pointermove", point);
    assert.equal(labels.tooltip.visible, true);
    assert.equal(tooltipText(labels), "#2 Deuxième");
  });

  test("elle se place au-dessus de la feature survolée", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    const p = notePos(model, 2);
    renderer.domElement.dispatch("pointermove", aimAt(api, p));
    assert.equal(labels.tooltip.position.x, p.x);
    assert.equal(labels.tooltip.position.z, p.z);
    assert.ok(labels.tooltip.position.y > p.y);
  });

  test("un titre qui contient du HTML s'affiche tel quel : texte brut, aucun nœud enfant, innerHTML jamais utilisé", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    renderer.domElement.dispatch("pointermove", aimAt(api, notePos(model, 3)));
    assert.equal(tooltipText(labels), `#3 ${XSS}`);
    assert.deepEqual(labels.tooltip.element.children, []);
    // Les étiquettes des stations aussi sont des éléments sans enfant.
    for (const object of labelObjects(labels)) assert.deepEqual(object.element.children, []);
  });

  test("le pointeur quitte la feature, ou le canvas : l'info-bulle disparaît", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    renderer.domElement.dispatch("pointermove", aimAt(api, notePos(model, 1)));
    assert.equal(labels.tooltip.visible, true);
    renderer.domElement.dispatch("pointermove", { clientX: 3, clientY: 3 });
    assert.equal(labels.tooltip.visible, false);

    renderer.domElement.dispatch("pointermove", aimAt(api, notePos(model, 1)));
    assert.equal(labels.tooltip.visible, true);
    renderer.domElement.dispatch("pointerleave");
    assert.equal(labels.tooltip.visible, false);
  });

  test("le titre change pendant le survol : le texte suit ; la feature disparaît : l'info-bulle aussi", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    renderer.domElement.dispatch("pointermove", aimAt(api, notePos(model, 1)));
    assert.equal(tooltipText(labels), "#1 Première");

    api.update(modelOf([feature(1, "ready", { title: "Renommée" }), feature(2, "in-progress")]));
    assert.equal(tooltipText(labels), "#1 Renommée");
    assert.equal(labels.tooltip.visible, true);

    api.update(modelOf([feature(2, "in-progress")]));
    assert.equal(labels.tooltip.visible, false);
  });

  test("l'info-bulle suit la feature quand elle change de station", () => {
    const { api, labels, renderer } = setup();
    api.update(modelOf([feature(1, "ready", { title: "Mobile" })]));
    api.frame(1000);
    const start = notePos(modelOf([feature(1, "ready")]), 1);
    renderer.domElement.dispatch("pointermove", aimAt(api, start));
    assert.equal(labels.tooltip.position.x, start.x);

    api.update(modelOf([feature(1, "in-review", { title: "Mobile" })]));
    const end = notePos(modelOf([feature(1, "in-review")]), 1);
    let t = 1000;
    for (let i = 0; i < 240; i++) api.frame((t += 1000 / 60));
    assert.ok(Math.abs(labels.tooltip.position.x - end.x) < 1e-4, "l'info-bulle a rejoint la nouvelle station");
  });

  test("un titre absent donne « #numéro » seul", () => {
    const { api, labels, renderer } = setup();
    const untitled = modelOf([feature(8, "ready", { title: null })]);
    api.update(untitled);
    api.frame(1000);
    renderer.domElement.dispatch("pointermove", aimAt(api, notePos(untitled, 8)));
    assert.equal(tooltipText(labels), "#8");
  });
});

describe("compteur « +N » d'une colonne pleine (CSS2DRenderer, textContent)", () => {
  const full = (extra) => modelOf(Array.from({ length: 8 + extra }, (_, i) => feature(i + 1, "in-progress")));
  const counterObjects = (labels) => [...labels.counters.values()];

  test("une colonne au-delà du plafond affiche « +N » sous ses post-its, dans la colonne", () => {
    const { api, labels } = setup();
    api.update(full(3));
    api.frame(1000);
    assert.deepEqual(counterObjects(labels).map((o) => o.element.textContent), ["+3"]);
    const [counter] = counterObjects(labels);
    assert.equal(counter.position.x, OFFICE.kanban.columns.find((c) => c.id === "dev").x);
    assert.ok(counter.position.y < notePos(full(3), 8).y, "sous le dernier post-it affiché");
    assert.ok(labels.group.children.includes(counter));
    assert.equal(counter.element.className, "label label-counter");
  });

  test("le nombre change : le même objet est réécrit ; la colonne repasse sous le plafond : le compteur est retiré", () => {
    const { api, labels } = setup();
    api.update(full(3));
    const [counter] = counterObjects(labels);
    api.update(full(5));
    assert.equal(counterObjects(labels)[0], counter, "même objet");
    assert.equal(counter.element.textContent, "+5");
    api.update(full(0));
    assert.equal(labels.counters.size, 0);
    assert.equal(labels.group.children.includes(counter), false);
  });

  test("aucun compteur sans colonne pleine", () => {
    const { api, labels } = setup();
    api.update(full(0));
    assert.equal(labels.counters.size, 0);
  });
});

describe("badges de retry sur le kanban (CSS2DObject, textContent)", () => {
  const badgeObjects = (labels) => labels.group.children.filter((o) => o.isCSS2DObject && o.element.className.includes("badge-retry"));

  test("un post-it avec retry >= 1 porte un badge visible à son bord ; sans retry, aucun", () => {
    const { api, labels } = setup();
    api.update(modelOf([feature(1, "in-progress", { retry: 2 }), feature(2, "in-progress", { retry: 0 }), feature(3, "in-review", { retry: 1 })]));
    api.frame(1000);
    assert.deepEqual([...labels.badges.keys()], [1, 3]);
    const badge = labels.badges.get(1);
    assert.equal(badge.element.textContent, retryBadgeText(2));
    assert.equal(labels.badges.get(3).element.textContent, "Retry 1");
    assert.equal(badge.element.className, "badge badge-retry");
    assert.equal(badge.visible, true);
    const p = api.positionOf(1);
    assert.ok(badge.position.x > p.x && badge.position.x <= p.x + OFFICE.kanban.noteWidth / 2, "au bord droit du post-it");
    assert.ok(badge.position.z > p.z, "devant le post-it");
    assert.equal(badgeObjects(labels).length, 2);
  });

  test("le badge suit son post-it pendant son déplacement", () => {
    const start = modelOf([feature(7, "in-progress", { retry: 1 })]);
    const moved = apply(start, evt("feature.status", 1, { issue: 7, status: "in-review" }));
    const { api, labels } = setup();
    api.update(start);
    let t = 1000;
    api.frame(t);
    api.update(moved.model, moved.transitions);
    for (let i = 0; i < 20; i++) api.frame((t += 1000 / 60));
    const badge = labels.badges.get(7);
    const p = api.positionOf(7);
    assert.ok(p.x > notePos(start, 7).x, "le post-it a quitté sa colonne");
    assert.ok(Math.abs(badge.position.x - (p.x + OFFICE.kanban.noteWidth / 2 - 0.1)) < 1e-9, "et le badge l'a suivi");
  });

  test("le compteur change : le texte est mis à jour sur le même badge ; retry retombé à 0 : le badge est retiré", () => {
    const { api, labels } = setup();
    api.update(modelOf([feature(1, "in-progress", { retry: 1 })]));
    api.frame(1000);
    const badge = labels.badges.get(1);
    api.update(modelOf([feature(1, "in-progress", { retry: 3 })]));
    assert.equal(labels.badges.get(1), badge, "même objet");
    assert.equal(badge.element.textContent, "Retry 3");
    api.update(modelOf([feature(1, "in-progress", { retry: 0 })]));
    assert.equal(labels.badges.size, 0);
    assert.equal(labels.group.children.includes(badge), false);
    assert.equal(badge.element.removed, true, "l'élément quitte la couche d'étiquettes");
  });

  test("une feature qui n'est plus dessinée n'affiche plus son badge", () => {
    const { api, labels } = setup();
    api.update(modelOf([feature(1, "in-progress", { retry: 1 })]));
    api.frame(1000);
    api.update(modelOf([]));
    assert.equal(labels.badges.size, 0);
  });

  test("le badge ne passe jamais par innerHTML : un titre piégé reste hors du badge", () => {
    const { api, labels } = setup();
    api.update(modelOf([feature(1, "in-progress", { retry: 1, title: XSS })]));
    api.frame(1000);
    assert.equal(labels.badges.get(1).element.textContent, "Retry 1");
    assert.deepEqual(labels.badges.get(1).element.children, []);
  });
});

describe("cycle de vie", () => {
  test("dispose retire les écouteurs, la couche d'étiquettes et le groupe de la scène", () => {
    const { api, labels, renderer, labelRenderer } = setup();
    assert.equal(renderer.domElement.listenerCount("pointermove"), 1);
    labels.dispose();
    assert.equal(renderer.domElement.listenerCount("pointermove"), 0);
    assert.equal(renderer.domElement.listenerCount("pointerleave"), 0);
    assert.equal(labelRenderer.domElement.removed, true);
    assert.equal(api.scene.children.includes(labels.group), false);
    api.frame(1000);
    assert.equal(labelRenderer.renders, 0, "plus de rendu des étiquettes");
  });
});
