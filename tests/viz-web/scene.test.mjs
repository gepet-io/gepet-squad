// Tests de viz/public/js/scene.js avec un moteur de rendu factice (pas de WebGL) : le graphe Three.js est réel (stations,
// InstancedMesh, caméra, lancer de rayon), seul le rendu final est simulé. `three` est résolu comme par l'importmap de la page.
import "./three-register.mjs";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { init } from "../../viz/public/js/state.js";
import { escaladeBoxes, layoutFeatures, stationBoxes } from "../../viz/public/js/layout.js";
import { STATUS_COLORS } from "../../viz/public/js/view-model.js";
import { fakeContainer, fakeRenderer, fakeWindow } from "./dom-fakes.mjs";
import { feature, stateOf } from "./support.mjs";

let THREE;
let createScene;
before(async () => {
  THREE = await import("three");
  ({ createScene } = await import("../../viz/public/js/scene.js"));
});

const modelOf = (features) => init(stateOf({ features }));

function setup({ width = 800, height = 600 } = {}) {
  const container = fakeContainer(width, height);
  const renderer = fakeRenderer({ width, height });
  const win = fakeWindow(width, height);
  const api = createScene({ container, renderer, window: win });
  return { api, container, renderer, win };
}

const featureMesh = (api) => api.scene.children.find((o) => o.isInstancedMesh);
const positionOfInstance = (mesh, index) => new THREE.Vector3().setFromMatrixPosition(mesh.getMatrixAt(index, new THREE.Matrix4()));
const colorOfInstance = (mesh, index) => mesh.getColorAt(index, new THREE.Color()).getHex();
const run = (api, seconds, fps = 60) => {
  let t = 1000;
  api.frame(t);
  for (let i = 0; i < seconds * fps; i++) api.frame((t += 1000 / fps));
};

describe("décor : stations et zones d'escalade", () => {
  test("les 7 stations et les 7 zones d'escalade sont placées aux positions de layout.js", () => {
    const { api } = setup();
    const boxes = [...stationBoxes(), ...escaladeBoxes()];
    assert.equal(boxes.length, 14);
    assert.equal(api.decor.children.length, 14);
    assert.ok(api.scene.children.includes(api.decor));
    boxes.forEach((box, index) => {
      const group = api.decor.children[index];
      assert.deepEqual([group.position.x, group.position.y, group.position.z], [box.x, box.y, box.z], `boîte ${index}`);
    });
  });

  test("chaque boîte a un sol à la taille de la boîte et des arêtes à sa hauteur", () => {
    const { api } = setup();
    const box = stationBoxes()[2];
    const [floor, edges] = api.decor.children[2].children;
    floor.geometry.computeBoundingBox();
    const size = floor.geometry.boundingBox.getSize(new THREE.Vector3());
    assert.equal(size.x, box.width);
    assert.equal(size.z, box.depth);
    edges.geometry.computeBoundingBox();
    assert.equal(edges.geometry.boundingBox.getSize(new THREE.Vector3()).y, box.height);
  });

  test("la caméra cadre toute l'emprise : les 14 boîtes sont dans le champ", () => {
    const { api } = setup();
    api.camera.updateMatrixWorld();
    for (const box of [...stationBoxes(), ...escaladeBoxes()]) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const p = new THREE.Vector3(box.x + (sx * box.width) / 2, 0, box.z + (sz * box.depth) / 2).project(api.camera);
          assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1, `coin de ${box.id} hors champ : ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`);
        }
      }
    }
  });

  test("les contrôles OrbitControls sont branchés sur le canvas, avec le point de visée au centre de la scène", () => {
    const { api, renderer } = setup();
    assert.equal(api.controls.constructor.name, "OrbitControls");
    assert.equal(api.controls.domElement, renderer.domElement);
    assert.equal(renderer.domElement.listenerCount("pointerdown"), 1);
    assert.equal(renderer.domElement.listenerCount("wheel"), 1);
    assert.equal(api.controls.target.x, 0);
  });

  test("le canvas est ajouté au conteneur et la boucle de rendu est lancée", () => {
    const { container, renderer, api } = setup();
    assert.deepEqual(container.children, [renderer.domElement]);
    assert.equal(typeof renderer.loop, "function");
    assert.equal(renderer.loop, api.frame);
  });
});

describe("features : un InstancedMesh coloré par statut", () => {
  const model = modelOf([
    feature(1, "ready"),
    feature(2, "in-progress"),
    feature(3, "in-review"),
    feature(4, "blocked"),
    feature(5, "done"),
  ]);

  test("une instance par feature, à la position de layout.js, de la couleur de son statut", () => {
    const { api } = setup();
    api.update(model);
    run(api, 0.1);
    const mesh = featureMesh(api);
    assert.equal(api.scene.children.filter((o) => o.isInstancedMesh).length, 1, "un seul InstancedMesh pour toutes les features");
    assert.equal(mesh.count, 5);
    const positions = layoutFeatures(model);
    const expected = [
      [1, STATUS_COLORS.ready],
      [2, STATUS_COLORS["in-progress"]],
      [3, STATUS_COLORS["in-review"]],
      [4, STATUS_COLORS.blocked],
      [5, STATUS_COLORS.done],
    ];
    expected.forEach(([number, color], index) => {
      const p = positionOfInstance(mesh, index);
      const target = positions.get(number);
      assert.ok(Math.abs(p.x - target.x) < 1e-4 && Math.abs(p.y - target.y) < 1e-4 && Math.abs(p.z - target.z) < 1e-4, `position de #${number}`);
      assert.equal(colorOfInstance(mesh, index), color, `couleur de #${number}`);
    });
  });

  test("les features sont rangées dans leur station : les x croissent avec l'avancement du workflow", () => {
    const { api } = setup();
    api.update(model);
    run(api, 0.1);
    const mesh = featureMesh(api);
    const x = (index) => positionOfInstance(mesh, index).x;
    assert.ok(x(0) < x(1) && x(1) < x(2), "roadmap < dev < verification");
    assert.ok(positionOfInstance(mesh, 3).z < -8, "la feature bloquée est dans la zone d'escalade, derrière la station");
  });

  test("sans modèle, aucune feature n'est dessinée", () => {
    const { api } = setup();
    api.update(modelOf([]));
    run(api, 0.1);
    assert.equal(featureMesh(api).count, 0);
  });

  test("une feature qui change de station s'y déplace, en moins de 3 s, sans rechargement", () => {
    const { api } = setup();
    api.update(modelOf([feature(7, "in-progress")]));
    run(api, 0.1);
    const mesh = featureMesh(api);
    const before = positionOfInstance(mesh, 0);

    api.update(modelOf([feature(7, "in-review")]));
    const target = layoutFeatures(modelOf([feature(7, "in-review")])).get(7);
    assert.ok(Math.abs(before.x - target.x) > 20, "la station d'arrivée est loin de celle de départ");

    api.frame(10_000);
    api.frame(10_000 + 1000 / 60);
    const midway = positionOfInstance(mesh, 0);
    assert.ok(midway.x > before.x && midway.x < target.x, "en cours de déplacement après une image");

    let elapsed = 0;
    let t = 10_000 + 1000 / 60;
    while (elapsed < 3 && Math.abs(positionOfInstance(mesh, 0).x - target.x) > 1e-4) {
      api.frame((t += 1000 / 60));
      elapsed += 1 / 60;
    }
    assert.ok(elapsed < 3, `arrivée après ${elapsed.toFixed(2)} s`);
    const p = positionOfInstance(mesh, 0);
    assert.ok(Math.abs(p.x - target.x) < 1e-4 && Math.abs(p.z - target.z) < 1e-4);
    assert.equal(colorOfInstance(mesh, 0), STATUS_COLORS["in-review"], "et la couleur suit le statut");
  });

  test("une feature qui apparaît est dessinée directement à sa place", () => {
    const { api } = setup();
    api.update(modelOf([feature(1, "ready")]));
    run(api, 0.05);
    api.update(modelOf([feature(1, "ready"), feature(2, "done")]));
    api.frame(50_000);
    const target = layoutFeatures(modelOf([feature(1, "ready"), feature(2, "done")])).get(2);
    const p = positionOfInstance(featureMesh(api), 1);
    assert.ok(Math.abs(p.x - target.x) < 1e-4, "pas de glissement depuis l'origine");
  });

  test("au-delà de la capacité initiale, le maillage grandit et toutes les features restent dessinées", () => {
    const { api } = setup();
    const many = Array.from({ length: 150 }, (_, i) => feature(i + 1, ["ready", "in-progress", "done"][i % 3]));
    api.update(modelOf(many.slice(0, 10)));
    run(api, 0.05);
    const small = featureMesh(api);
    api.update(modelOf(many));
    run(api, 0.05);
    const mesh = featureMesh(api);
    assert.notEqual(mesh, small, "maillage recréé");
    assert.equal(api.scene.children.filter((o) => o.isInstancedMesh).length, 1, "l'ancien est retiré de la scène");
    assert.ok(mesh.instanceMatrix.count >= 150);
    assert.equal(mesh.count, 150);
    assert.equal(colorOfInstance(mesh, 149), STATUS_COLORS.done, "#150 : 150 % 3 == 0 -> done");
    assert.equal(colorOfInstance(mesh, 148), STATUS_COLORS["in-progress"], "#149");
  });

  test("positionOf et featureByNumber décrivent la feature affichée", () => {
    const { api } = setup();
    api.update(modelOf([feature(3, "in-test", { title: "Titre" })]));
    assert.equal(api.featureByNumber(3).title, "Titre");
    assert.equal(api.featureByNumber(99), null);
    const expected = layoutFeatures(modelOf([feature(3, "in-test")])).get(3);
    assert.deepEqual(api.positionOf(3), { x: expected.x, y: expected.y, z: expected.z });
    assert.equal(api.positionOf(99), null);
  });
});

describe("pick : de l'écran à la feature (correspondance instance -> feature)", () => {
  function screenPoint(api, position, size = { width: 800, height: 600 }) {
    api.camera.updateMatrixWorld();
    const ndc = new THREE.Vector3(position.x, position.y, position.z).project(api.camera);
    return { x: ((ndc.x + 1) / 2) * size.width, y: ((1 - ndc.y) / 2) * size.height };
  }

  test("cliquer sur une feature rend cette feature, ailleurs rend null", () => {
    const { api } = setup({ width: 1600, height: 900 });
    // Une scène zoomée : la caméra est rapprochée pour que les cubes (0,9) fassent plusieurs pixels.
    const model = modelOf([feature(1, "ready", { title: "Un" }), feature(2, "in-progress", { title: "Deux" }), feature(3, "in-review", { title: "Trois" })]);
    api.update(model);
    run(api, 0.05);
    const target = layoutFeatures(model).get(2);
    api.camera.position.set(target.x, target.y + 12, target.z + 12);
    api.camera.lookAt(target.x, target.y, target.z);
    api.camera.updateMatrixWorld();

    const at = screenPoint(api, target, { width: 1600, height: 900 });
    const hit = api.pick(at.x, at.y);
    assert.equal(hit.number, 2);
    assert.equal(hit.title, "Deux");
    assert.equal(api.pick(5, 5), null, "le coin de l'écran ne touche aucune feature");
  });

  test("sans feature ou sans maillage, pick rend null", () => {
    const { api } = setup();
    assert.equal(api.pick(400, 300), null);
    api.update(modelOf([]));
    assert.equal(api.pick(400, 300), null);
  });

  test("un canvas de taille nulle ne produit pas de sélection", () => {
    const container = fakeContainer(800, 600);
    const renderer = fakeRenderer({ width: 0, height: 0 });
    const api = createScene({ container, renderer, window: fakeWindow() });
    api.update(modelOf([feature(1, "ready")]));
    assert.equal(api.pick(10, 10), null);
  });
});

describe("points d'extension pour #14 : onFrame, addLayer, onUpdate", () => {
  test("onFrame : rappel à chaque image avec le temps écoulé (delta, total), et désinscription", () => {
    const { api, renderer } = setup();
    const calls = [];
    const off = api.onFrame((delta, elapsed) => calls.push([delta, elapsed]));
    renderer.loop(1000);
    renderer.loop(1016);
    renderer.loop(1100);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], [0, 1], "première image : delta nul");
    assert.ok(Math.abs(calls[1][0] - 0.016) < 1e-9);
    assert.ok(Math.abs(calls[2][0] - 0.084) < 1e-9);
    assert.ok(Math.abs(calls[2][1] - 1.1) < 1e-9);
    off();
    renderer.loop(1200);
    assert.equal(calls.length, 3, "plus de rappel après désinscription");
  });

  test("onFrame : un long arrêt (onglet masqué) est borné à 0,1 s", () => {
    const { api } = setup();
    const deltas = [];
    api.onFrame((delta) => deltas.push(delta));
    api.frame(1000);
    api.frame(61_000);
    assert.equal(deltas[1], 0.1);
  });

  test("onFrame est appelé avant le rendu de l'image, qui a bien lieu à chaque image", () => {
    const { api, renderer } = setup();
    let rendersSeenByCallback = -1;
    api.onFrame(() => (rendersSeenByCallback = renderer.renders));
    api.frame(1000);
    assert.equal(rendersSeenByCallback, 0);
    assert.equal(renderer.renders, 1);
  });

  test("addLayer ajoute un objet à la scène, et la fonction renvoyée le retire", () => {
    const { api } = setup();
    const layer = new THREE.Group();
    const remove = api.addLayer(layer);
    assert.ok(api.scene.children.includes(layer));
    assert.equal(layer.parent, api.scene);
    remove();
    assert.equal(api.scene.children.includes(layer), false);
  });

  test("onUpdate : reçoit le modèle et les transitions à chaque update, et se désinscrit", () => {
    const { api } = setup();
    const seen = [];
    const off = api.onUpdate((model, transitions) => seen.push([model, transitions]));
    const model = modelOf([feature(1, "ready")]);
    const transitions = [{ kind: "feature-add", id: 1, from: null, to: "roadmap" }];
    api.update(model, transitions);
    assert.equal(seen[0][0], model);
    assert.equal(seen[0][1], transitions);
    off();
    api.update(model);
    assert.equal(seen.length, 1);
  });
});

describe("redimensionnement", () => {
  test("la taille initiale est celle du conteneur ; un resize de la fenêtre met à jour moteur, caméra et écouteurs", () => {
    const { api, container, renderer, win } = setup({ width: 800, height: 600 });
    assert.deepEqual(renderer.sizes.at(-1), [800, 600]);
    assert.ok(Math.abs(api.camera.aspect - 800 / 600) < 1e-9);
    const sizes = [];
    api.onResize((w, h) => sizes.push([w, h]));
    assert.equal(win.listenerCount("resize"), 1);

    container.clientWidth = 1200;
    container.clientHeight = 500;
    win.dispatch("resize");
    assert.deepEqual(renderer.sizes.at(-1), [1200, 500]);
    assert.deepEqual(sizes, [[1200, 500]]);
    assert.ok(Math.abs(api.camera.aspect - 1200 / 500) < 1e-9);
    // La matrice de projection suit : un point au bord droit de l'emprise change de position à l'écran.
    assert.ok(Math.abs(api.camera.projectionMatrix.elements[5] / api.camera.projectionMatrix.elements[0] - 1200 / 500) < 1e-9);
  });

  test("un resize ne déplace pas la caméra (l'utilisateur garde son point de vue)", () => {
    const { api, container, win } = setup();
    const before = api.camera.position.clone();
    container.clientWidth = 300;
    win.dispatch("resize");
    assert.ok(api.camera.position.equals(before));
  });

  test("un conteneur sans taille retombe sur la fenêtre", () => {
    const container = fakeContainer(0, 0);
    const renderer = fakeRenderer();
    createScene({ container, renderer, window: fakeWindow(1024, 768) });
    assert.deepEqual(renderer.sizes.at(-1), [1024, 768]);
  });

  test("resize(largeur, hauteur) accepte une taille explicite", () => {
    const { api, renderer } = setup();
    api.resize(640, 480);
    assert.deepEqual(renderer.sizes.at(-1), [640, 480]);
  });
});

describe("cycle de vie", () => {
  test("dispose arrête la boucle, retire l'écouteur de la fenêtre et les contrôles", () => {
    const { api, renderer, win } = setup();
    const calls = [];
    api.onFrame(() => calls.push(1));
    api.update(modelOf([feature(1, "ready")]));
    api.dispose();
    assert.equal(renderer.loop, null);
    assert.equal(win.listenerCount("resize"), 0);
    assert.equal(renderer.domElement.listenerCount("pointerdown"), 0);
    assert.equal(renderer.disposed, true);
    assert.equal(renderer.domElement.removed, true);
  });

  test("si la construction échoue après la création du canvas (contrôles de caméra), le moteur de rendu et le canvas sont libérés", () => {
    const container = fakeContainer();
    const renderer = fakeRenderer();
    const win = fakeWindow();
    const failure = new Error("contrôles indisponibles");
    assert.throws(
      () =>
        createScene({
          container,
          renderer,
          window: win,
          createControls() {
            assert.deepEqual(container.children, [renderer.domElement], "le canvas est déjà dans la page quand les contrôles échouent");
            throw failure;
          },
        }),
      (error) => error === failure,
      "l'erreur d'origine remonte, inchangée",
    );
    assert.equal(renderer.disposed, true, "renderer.dispose() appelé");
    assert.equal(renderer.domElement.removed, true, "canvas retiré du DOM");
    assert.equal(renderer.loop === undefined || renderer.loop === null, true, "aucune boucle de rendu ne tourne");
    assert.equal(win.listenerCount("resize"), 0, "aucun écouteur laissé sur la fenêtre");
  });

  test("un échec de construction n'appelle pas dispose sur un moteur de rendu sans méthode dispose (injection minimale)", () => {
    const renderer = fakeRenderer();
    delete renderer.dispose;
    assert.throws(() => createScene({ container: fakeContainer(), renderer, window: fakeWindow(), createControls: () => { throw new Error("x"); } }), /x/);
    assert.equal(renderer.domElement.removed, true);
  });

  test("sans WebGL, createScene lève une erreur (main.js bascule alors sur le repli texte)", () => {
    assert.throws(() => createScene({ container: fakeContainer(), window: fakeWindow() }));
  });
});
