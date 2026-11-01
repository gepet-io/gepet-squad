// Tests de viz/public/js/labels.js : noms des stations, info-bulle au survol, texte uniquement par `textContent`.
// Le graphe Three.js est réel (CSS2DObject, lancer de rayon), le DOM et le moteur de rendu sont factices ; les éléments
// factices lèvent une erreur si l'on écrit dans innerHTML ou outerHTML.
import "./three-register.mjs";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { init } from "../../viz/public/js/state.js";
import { escaladeBoxes, layoutFeatures, stationBoxes } from "../../viz/public/js/layout.js";
import { fakeContainer, fakeDocument, fakeElement, fakeRenderer, fakeWindow } from "./dom-fakes.mjs";
import { feature, stateOf } from "./support.mjs";

let THREE;
let createScene;
let createLabels;
before(async () => {
  THREE = await import("three");
  ({ createScene } = await import("../../viz/public/js/scene.js"));
  ({ createLabels } = await import("../../viz/public/js/labels.js"));
});

const XSS = '<img src=x onerror="document.title=1">';
const modelOf = (features) => init(stateOf({ features }));

function setup() {
  const container = fakeContainer(1600, 900);
  const renderer = fakeRenderer({ width: 1600, height: 900 });
  const api = createScene({ container, renderer, window: fakeWindow(1600, 900) });
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
  const labels = createLabels(api, { container, document: fakeDocument(), labelRenderer });
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

describe("noms des stations", () => {
  test("une étiquette par station, dans l'ordre du pipeline, au pied de la station", () => {
    const { labels } = setup();
    const stations = labelObjects(labels).filter((o) => o.element.className.includes("label-station"));
    assert.deepEqual(stations.map((o) => o.element.textContent), [
      "Cadrage",
      "Roadmap",
      "Développement",
      "Vérification",
      "Test",
      "Merge",
      "Release",
    ]);
    stationBoxes().forEach((box, index) => {
      assert.equal(stations[index].position.x, box.x);
      assert.ok(stations[index].position.z > box.z + box.depth / 2, "devant la station");
    });
  });

  test("une étiquette « Escalade » par zone d'escalade, à la place de la zone", () => {
    const { labels } = setup();
    const zones = labelObjects(labels).filter((o) => o.element.className.includes("label-escalade"));
    assert.equal(zones.length, 7);
    assert.ok(zones.every((o) => o.element.textContent === "Escalade"));
    escaladeBoxes().forEach((box, index) => {
      assert.equal(zones[index].position.x, box.x);
      assert.ok(Math.abs(zones[index].position.z - box.z) <= box.depth / 2);
    });
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

describe("info-bulle au survol d'une feature", () => {
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

    const point = aimAt(api, layoutFeatures(model).get(2));
    renderer.domElement.dispatch("pointermove", point);
    assert.equal(labels.tooltip.visible, true);
    assert.equal(tooltipText(labels), "#2 Deuxième");
  });

  test("elle se place au-dessus de la feature survolée", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    const p = layoutFeatures(model).get(2);
    renderer.domElement.dispatch("pointermove", aimAt(api, p));
    assert.equal(labels.tooltip.position.x, p.x);
    assert.equal(labels.tooltip.position.z, p.z);
    assert.ok(labels.tooltip.position.y > p.y);
  });

  test("un titre qui contient du HTML s'affiche tel quel : texte brut, aucun nœud enfant, innerHTML jamais utilisé", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    renderer.domElement.dispatch("pointermove", aimAt(api, layoutFeatures(model).get(3)));
    assert.equal(tooltipText(labels), `#3 ${XSS}`);
    assert.deepEqual(labels.tooltip.element.children, []);
    // Les étiquettes des stations aussi sont des éléments sans enfant.
    for (const object of labelObjects(labels)) assert.deepEqual(object.element.children, []);
  });

  test("le pointeur quitte la feature, ou le canvas : l'info-bulle disparaît", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    renderer.domElement.dispatch("pointermove", aimAt(api, layoutFeatures(model).get(1)));
    assert.equal(labels.tooltip.visible, true);
    renderer.domElement.dispatch("pointermove", { clientX: 3, clientY: 3 });
    assert.equal(labels.tooltip.visible, false);

    renderer.domElement.dispatch("pointermove", aimAt(api, layoutFeatures(model).get(1)));
    assert.equal(labels.tooltip.visible, true);
    renderer.domElement.dispatch("pointerleave");
    assert.equal(labels.tooltip.visible, false);
  });

  test("le titre change pendant le survol : le texte suit ; la feature disparaît : l'info-bulle aussi", () => {
    const { api, labels, renderer } = setup();
    api.update(model);
    api.frame(1000);
    renderer.domElement.dispatch("pointermove", aimAt(api, layoutFeatures(model).get(1)));
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
    const start = layoutFeatures(modelOf([feature(1, "ready")])).get(1);
    renderer.domElement.dispatch("pointermove", aimAt(api, start));
    assert.equal(labels.tooltip.position.x, start.x);

    api.update(modelOf([feature(1, "in-review", { title: "Mobile" })]));
    const end = layoutFeatures(modelOf([feature(1, "in-review")])).get(1);
    let t = 1000;
    for (let i = 0; i < 240; i++) api.frame((t += 1000 / 60));
    assert.ok(Math.abs(labels.tooltip.position.x - end.x) < 1e-4, "l'info-bulle a rejoint la nouvelle station");
  });

  test("un titre absent donne « #numéro » seul", () => {
    const { api, labels, renderer } = setup();
    const untitled = modelOf([feature(8, "ready", { title: null })]);
    api.update(untitled);
    api.frame(1000);
    renderer.domElement.dispatch("pointermove", aimAt(api, layoutFeatures(untitled).get(8)));
    assert.equal(tooltipText(labels), "#8");
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
