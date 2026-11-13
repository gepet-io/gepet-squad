// Tests de viz/public/js/scene.js avec un moteur de rendu factice (pas de WebGL) et un faux chargeur glTF : le graphe Three.js
// est réel (décor, mobilier cloné, InstancedMesh des post-its, caméra, lancer de rayon), seul le rendu final et la lecture des
// fichiers .glb sont simulés (les .glb vendorisés sont lus par kenney-assets.test.mjs). `three` est résolu comme par l'importmap.
import "./three-register.mjs";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { apply, init } from "../../viz/public/js/state.js";
import { ASSETS } from "../../viz/public/js/assets.js";
import { KANBAN_MAX_PER_COLUMN, OFFICE, kanbanLayout } from "../../viz/public/js/office-layout.js";
import { STATUS_COLORS } from "../../viz/public/js/view-model.js";
import { fakeContainer, fakeLoader, fakeRenderer, fakeWindow } from "./dom-fakes.mjs";
import { evt, feature, stateOf } from "./support.mjs";

let THREE;
let createScene;
before(async () => {
  THREE = await import("three");
  ({ createScene } = await import("../../viz/public/js/scene.js"));
});

const modelOf = (features) => init(stateOf({ features }));

function setup({ width = 800, height = 600, loadModel, onAssetsFailed } = {}) {
  const container = fakeContainer(width, height);
  const renderer = fakeRenderer({ width, height });
  const win = fakeWindow(width, height);
  const loader = loadModel ?? fakeLoader(THREE);
  const api = createScene({ container, renderer, window: win, loadModel: loader, onAssetsFailed });
  return { api, container, renderer, win, loader };
}

const noteMesh = (api) => api.scene.children.find((o) => o.isInstancedMesh);
const positionOfInstance = (mesh, index) => new THREE.Vector3().setFromMatrixPosition(mesh.getMatrixAt(index, new THREE.Matrix4()));
const colorOfInstance = (mesh, index) => mesh.getColorAt(index, new THREE.Color()).getHex();
const near = (a, b, eps = 1e-4, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} != ${b}`);
const columnX = (id) => OFFICE.kanban.columns.find((c) => c.id === id).x;
const run = (api, seconds, fps = 60) => {
  let t = 1000;
  api.frame(t);
  for (let i = 0; i < seconds * fps; i++) api.frame((t += 1000 / fps));
};
// Fait avancer la boucle d'une scène déjà démarrée (l'horloge continue).
function clockOf(api) {
  let t = 1000;
  api.frame(t);
  return (seconds, fps = 60) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) api.frame((t += 1000 / fps));
  };
}

describe("décor : murs, sol, plus de stations abstraites", () => {
  test("le sol couvre l'emprise des murs d'OFFICE, et des murs entourent le bureau", () => {
    const { api } = setup();
    const { walls } = OFFICE;
    const sizes = api.decor.children
      .filter((o) => o.isMesh && o.geometry.type === "BoxGeometry")
      .map((o) => {
        o.geometry.computeBoundingBox();
        return o.geometry.boundingBox.getSize(new THREE.Vector3());
      });
    assert.ok(sizes.some((s) => s.x === walls.maxX - walls.minX && s.z === walls.maxZ - walls.minZ && s.y < 1), "sol");
    assert.ok(sizes.filter((s) => s.y === walls.height).length >= 3, "mur du fond, mur droit, mur gauche (en deux pans autour de la porte)");
    assert.ok(api.scene.children.includes(api.decor));
  });

  test("les stations abstraites (volumes à arêtes) et les files de features de layout.js ne sont plus dessinées", () => {
    const { api } = setup();
    let edges = 0;
    let groups = 0;
    api.decor.traverse((o) => {
      if (o.isLineSegments) edges += 1;
      if (o.isGroup && o !== api.decor) groups += 1;
    });
    assert.equal(edges, 0);
    assert.equal(groups, 0);
    api.update(modelOf([feature(1, "in-progress")]));
    run(api, 0.1);
    // Le seul maillage de features est celui des post-its, sur le mur du fond.
    near(positionOfInstance(noteMesh(api), 0).z, OFFICE.kanban.z, 1e-5);
  });

  test("la salle d'escalade est teintée en rouge", () => {
    const { api } = setup();
    const tinted = api.decor.children.filter((o) => o.isMesh && o.geometry.type === "PlaneGeometry" && o.material.transparent);
    assert.equal(tinted.length, 1);
    assert.equal(tinted[0].material.color.getHexString(), new THREE.Color(OFFICE.zones.escalade.tint).getHexString());
    assert.equal(tinted[0].position.x, OFFICE.zones.escalade.x);
    assert.equal(tinted[0].position.z, OFFICE.zones.escalade.z);
  });

  test("la caméra cadre tout le bureau et le kanban : coins des murs et du panneau dans le champ", () => {
    const { api } = setup();
    api.camera.updateMatrixWorld();
    const { walls, kanban } = OFFICE;
    const corners = [];
    for (const x of [walls.minX, walls.maxX]) for (const z of [walls.minZ, walls.maxZ]) for (const y of [0, walls.height]) corners.push([x, y, z]);
    const first = kanban.columns[0].x - kanban.columnWidth / 2;
    const last = kanban.columns.at(-1).x + kanban.columnWidth / 2;
    for (const x of [first, last]) for (const y of [kanban.top, kanban.top - KANBAN_MAX_PER_COLUMN * kanban.rowStep]) corners.push([x, y, kanban.z]);
    for (const [x, y, z] of corners) {
      const p = new THREE.Vector3(x, y, z).project(api.camera);
      assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1, `point (${x}, ${y}, ${z}) hors champ : ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`);
    }
  });

  test("les contrôles OrbitControls sont branchés sur le canvas, avec le point de visée au centre du bureau", () => {
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

describe("mobilier : un fichier GLB chargé une fois, cloné à chaque meuble d'OFFICE", () => {
  test("un objet par meuble d'OFFICE, à sa position, sa rotation et l'échelle d'assets.js", async () => {
    const { api } = setup();
    await api.furnitureReady;
    assert.equal(api.furniture.children.length, OFFICE.furniture.length);
    assert.ok(api.scene.children.includes(api.furniture));
    OFFICE.furniture.forEach((piece, index) => {
      const object = api.furniture.children[index];
      assert.deepEqual([object.position.x, object.position.y, object.position.z], [piece.x, piece.y, piece.z], `meuble ${index} (${piece.id})`);
      assert.equal(object.rotation.y, piece.rotation, `rotation de ${piece.id}`);
      const scale = ASSETS.furniture.find((asset) => asset.id === piece.id).scale;
      assert.deepEqual([object.scale.x, object.scale.y, object.scale.z], [scale, scale, scale]);
    });
  });

  test("chaque fichier n'est chargé qu'une fois, au chemin d'assets.js, puis cloné (les clones partagent la géométrie)", async () => {
    const { api, loader } = setup();
    await api.furnitureReady;
    const ids = [...new Set(OFFICE.furniture.map((piece) => piece.id))];
    assert.ok(OFFICE.furniture.length > ids.length, "le bureau répète des meubles (chaises, écrans…)");
    assert.deepEqual([...loader.log].sort(), ids.map((id) => ASSETS.furniture.find((asset) => asset.id === id).path).sort());
    const chairs = api.furniture.children.filter((_, i) => OFFICE.furniture[i].id === "chairDesk");
    assert.ok(chairs.length >= 2);
    assert.notEqual(chairs[0], chairs[1], "des objets distincts");
    assert.equal(chairs[0].getObjectByProperty("isMesh", true).geometry, chairs[1].getObjectByProperty("isMesh", true).geometry, "partageant les mêmes données");
  });

  test("un modèle dont l'origine est à un coin (comme le Furniture Kit) est recentré : sa position est le centre de son emprise, posé au sol", async () => {
    const cornerLoader = async () => {
      const geometry = new THREE.BoxGeometry(1, 0.5, 2).translate(0.5, 0.25, -1); // x 0..1, y 0..0,5, z -2..0
      const root = new THREE.Group();
      root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
      return { scene: root };
    };
    const { api } = setup({ loadModel: cornerLoader });
    await api.furnitureReady;
    api.furniture.updateMatrixWorld(true);
    OFFICE.furniture.forEach((piece, index) => {
      const box = new THREE.Box3().setFromObject(api.furniture.children[index]);
      const scale = ASSETS.furniture.find((asset) => asset.id === piece.id).scale;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      near(box.min.y, piece.y, 1e-6, `${piece.id} posé sur son support`);
      near(size.y, 0.5 * scale, 1e-6);
      // Le meuble est pivoté par quarts de tour : son emprise (1 x 2, mise à l'échelle) est centrée sur sa position.
      near(center.x, piece.x, 1e-6, `${piece.id} centré en x`);
      near(center.z, piece.z, 1e-6, `${piece.id} centré en z`);
    });
  });

  test("la scène est utilisable avant la fin du chargement (post-its dessinés, mobilier posé ensuite)", async () => {
    const { api } = setup();
    assert.equal(api.furniture.children.length, 0, "rien avant la fin des chargements");
    api.update(modelOf([feature(1, "ready")]));
    run(api, 0.05);
    assert.equal(noteMesh(api).count, 1);
    await api.furnitureReady;
    assert.equal(api.furniture.children.length, OFFICE.furniture.length);
  });

  test("un fichier qui ne se charge pas est omis ; la scène continue, et l'échec est signalé une seule fois avec son nombre", async () => {
    const calls = [];
    const { api } = setup({ loadModel: fakeLoader(THREE, { fail: ["/desk.glb", "/table.glb"] }), onAssetsFailed: (count, ids) => calls.push({ count, ids }) });
    await api.furnitureReady;
    const expected = OFFICE.furniture.filter((piece) => piece.id !== "desk" && piece.id !== "table").length;
    assert.equal(api.furniture.children.length, expected);
    assert.deepEqual(calls, [{ count: 2, ids: ["desk", "table"] }]);
    api.update(modelOf([feature(1, "ready")]));
    run(api, 0.05);
    assert.equal(noteMesh(api).count, 1, "les post-its s'affichent quand même");
  });

  test("tous les fichiers en échec, y compris un chargeur qui lève sans promesse : aucune exception, une seule alerte", async () => {
    const calls = [];
    const throwing = () => {
      throw new Error("pas de réseau");
    };
    const { api } = setup({ loadModel: throwing, onAssetsFailed: (count) => calls.push(count) });
    await api.furnitureReady;
    assert.equal(api.furniture.children.length, 0);
    const distinct = new Set(OFFICE.furniture.map((piece) => piece.id)).size;
    assert.deepEqual(calls, [distinct]);
    api.update(modelOf([feature(1, "ready")]));
    assert.doesNotThrow(() => run(api, 0.05));
  });

  test("un chargeur qui rend un résultat sans scène compte comme un échec", async () => {
    const calls = [];
    const { api } = setup({ loadModel: async () => ({}), onAssetsFailed: (count) => calls.push(count) });
    await api.furnitureReady;
    assert.equal(api.furniture.children.length, 0);
    assert.equal(calls.length, 1);
  });

  test("aucune alerte quand tout se charge", async () => {
    const calls = [];
    const { api } = setup({ onAssetsFailed: (count) => calls.push(count) });
    await api.furnitureReady;
    assert.deepEqual(calls, []);
  });

  test("dispose avant la fin du chargement : le mobilier n'est pas posé", async () => {
    const { api } = setup();
    api.dispose();
    await api.furnitureReady;
    assert.equal(api.furniture.children.length, 0);
  });
});

describe("kanban : un plan mural, une colonne par station plus l'escalade", () => {
  test("une bande par colonne, la colonne d'escalade en rouge, sur le mur du fond", () => {
    const { api } = setup();
    const strips = api.decor.children.filter((o) => o.isMesh && o.geometry.type === "PlaneGeometry" && o.position.z > OFFICE.kanban.z && o.position.z < OFFICE.kanban.z + 0.1);
    assert.equal(strips.length, 8);
    assert.deepEqual(strips.map((s) => s.position.x), OFFICE.kanban.columns.map((c) => c.x));
    const reds = strips.filter((s) => s.material.color.r > s.material.color.g * 2);
    assert.equal(reds.length, 1);
    assert.equal(reds[0].position.x, columnX("escalade"));
  });
});

describe("post-its : un InstancedMesh coloré par statut", () => {
  const model = modelOf([feature(1, "ready"), feature(2, "in-progress"), feature(3, "in-review"), feature(4, "blocked"), feature(5, "done")]);

  test("une instance visible par post-it de kanbanLayout, à sa place, de la couleur de son statut", () => {
    const { api } = setup();
    api.update(model);
    run(api, 0.1);
    const mesh = noteMesh(api);
    assert.equal(api.scene.children.filter((o) => o.isInstancedMesh).length, 1, "un seul InstancedMesh pour toutes les features");
    const { notes } = kanbanLayout(model);
    assert.equal(mesh.count, notes.length);
    assert.equal(mesh.count, 5);
    const colors = { 1: STATUS_COLORS.ready, 2: STATUS_COLORS["in-progress"], 3: STATUS_COLORS["in-review"], 4: STATUS_COLORS.blocked, 5: STATUS_COLORS.done };
    const byNumber = new Map(notes.map((n) => [n.number, n]));
    [1, 2, 3, 4, 5].forEach((number, index) => {
      const p = positionOfInstance(mesh, index);
      const note = byNumber.get(number);
      assert.ok(Math.abs(p.x - note.x) < 1e-4 && Math.abs(p.y - note.y) < 1e-4 && Math.abs(p.z - note.z) < 1e-4, `position de #${number}`);
      assert.equal(colorOfInstance(mesh, index), colors[number], `couleur de #${number}`);
    });
  });

  test("les post-its sont rangés dans la colonne de leur station ; la feature bloquée est dans la colonne d'escalade", () => {
    const { api } = setup();
    api.update(model);
    run(api, 0.1);
    const mesh = noteMesh(api);
    near(positionOfInstance(mesh, 0).x, columnX("roadmap"));
    near(positionOfInstance(mesh, 1).x, columnX("dev"));
    near(positionOfInstance(mesh, 2).x, columnX("verification"));
    near(positionOfInstance(mesh, 3).x, columnX("escalade"));
    assert.ok(columnX("roadmap") < columnX("dev") && columnX("dev") < columnX("verification"));
  });

  test("au-delà du plafond d'une colonne, seuls les post-its affichés ont une instance (le reste est dans le compteur « +N »)", () => {
    const { api } = setup();
    const many = modelOf(Array.from({ length: KANBAN_MAX_PER_COLUMN + 4 }, (_, i) => feature(i + 1, "in-progress")));
    api.update(many);
    run(api, 0.05);
    assert.equal(noteMesh(api).count, KANBAN_MAX_PER_COLUMN);
    assert.equal(kanbanLayout(many).counters[0].extra, 4);
  });

  test("sans feature, aucun post-it n'est dessiné", () => {
    const { api } = setup();
    api.update(modelOf([]));
    run(api, 0.1);
    assert.equal(noteMesh(api).count, 0);
  });

  test("un post-it qui apparaît est dessiné directement à sa place", () => {
    const { api } = setup();
    api.update(modelOf([feature(1, "ready")]));
    run(api, 0.05);
    const next = modelOf([feature(1, "ready"), feature(2, "done")]);
    api.update(next);
    api.frame(50_000);
    const note = kanbanLayout(next).notes.find((n) => n.number === 2);
    near(positionOfInstance(noteMesh(api), 1).x, note.x);
    near(positionOfInstance(noteMesh(api), 1).y, note.y);
  });

  test("150 features : le plafond par colonne borne les instances, tous les post-its affichés sont dessinés, un seul maillage", () => {
    const { api } = setup();
    const statuses = ["ready", "in-progress", "done"];
    const many = Array.from({ length: 150 }, (_, i) => feature(i + 1, statuses[i % 3]));
    api.update(modelOf(many.slice(0, 10)));
    run(api, 0.05);
    const small = noteMesh(api);
    const next = modelOf(many);
    api.update(next);
    run(api, 0.05);
    const mesh = noteMesh(api);
    assert.equal(mesh, small, "le plafond (8 par colonne, 8 colonnes) tient dans la capacité initiale : pas de recréation");
    assert.equal(api.scene.children.filter((o) => o.isInstancedMesh).length, 1);
    assert.equal(mesh.count, kanbanLayout(next).notes.length);
    assert.equal(mesh.count, 3 * KANBAN_MAX_PER_COLUMN, "trois colonnes pleines (roadmap, dev, release), le reste dans les compteurs");
  });

  test("positionOf et featureByNumber décrivent le post-it affiché", () => {
    const { api } = setup();
    const next = modelOf([feature(3, "in-test", { title: "Titre" })]);
    api.update(next);
    assert.equal(api.featureByNumber(3).title, "Titre");
    assert.equal(api.featureByNumber(99), null);
    const note = kanbanLayout(next).notes[0];
    assert.deepEqual(api.positionOf(3), { x: note.x, y: note.y, z: note.z });
    assert.equal(api.positionOf(99), null);
  });
});

describe("feature-move : le post-it glisse vers sa nouvelle colonne (courbes de motion.js)", () => {
  const start = modelOf([feature(7, "in-progress")]);
  const moved = apply(start, evt("feature.status", 1, { issue: 7, status: "in-review" }));
  const x = (api) => positionOfInstance(noteMesh(api), 0).x;

  test("la transition de state.js est une feature-move dev -> verification", () => {
    assert.deepEqual(moved.transitions.filter((t) => t.kind === "feature-move"), [{ kind: "feature-move", id: 7, from: "dev", to: "verification" }]);
  });

  test("le post-it part de sa colonne, est en route après quelques images, puis arrive pile dans la nouvelle colonne", () => {
    const { api } = setup();
    api.update(start);
    const advance = clockOf(api);
    advance(0.1);
    near(x(api), columnX("dev"));

    api.update(moved.model, moved.transitions);
    advance(0.1);
    const early = x(api);
    assert.ok(early > columnX("dev") && early < columnX("verification"), `en route : ${early}`);
    advance(0.2);
    assert.ok(x(api) > early && x(api) < columnX("verification"), "pas encore arrivé");

    advance(2);
    near(x(api), columnX("verification"));
    assert.equal(colorOfInstance(noteMesh(api), 0), STATUS_COLORS["in-review"], "la couleur suit le statut");
  });

  test("le mouvement est continu : il ne recule jamais et ne saute jamais de plus d'un quart du trajet", () => {
    const { api } = setup();
    api.update(start);
    const advance = clockOf(api);
    advance(0.1);
    api.update(moved.model, moved.transitions);
    let previous = x(api);
    const span = columnX("verification") - columnX("dev");
    for (let i = 0; i < 120; i++) {
      advance(1 / 60);
      assert.ok(x(api) >= previous - 1e-9, "ne recule jamais");
      assert.ok(x(api) - previous < span / 4, `saut de ${x(api) - previous}`);
      previous = x(api);
    }
  });

  test("prefers-reduced-motion : le post-it est dans la nouvelle colonne dès l'image suivante, sans glissement", () => {
    const { api, win } = setup();
    win.media.reduced = true;
    api.update(start);
    const advance = clockOf(api);
    advance(0.1);
    api.update(moved.model, moved.transitions);
    advance(1 / 60);
    near(x(api), columnX("verification"));
  });

  test("la préférence est relue à chaque image : activée en plein déplacement, le post-it se pose aussitôt", () => {
    const { api, win } = setup();
    api.update(start);
    const advance = clockOf(api);
    advance(0.1);
    api.update(moved.model, moved.transitions);
    advance(0.15);
    assert.ok(x(api) < columnX("verification") - 0.05, "encore en route");
    win.media.reduced = true;
    advance(1 / 60);
    near(x(api), columnX("verification"));
  });

  test("une feature bloquée glisse vers la colonne d'escalade", () => {
    const { api } = setup();
    api.update(start);
    const advance = clockOf(api);
    advance(0.1);
    const blocked = apply(start, evt("feature.status", 1, { issue: 7, status: "blocked" }));
    assert.deepEqual(blocked.transitions.filter((t) => t.kind === "feature-move"), [{ kind: "feature-move", id: 7, from: "dev", to: "escalade" }]);
    api.update(blocked.model, blocked.transitions);
    advance(0.2);
    assert.ok(x(api) > columnX("dev") && x(api) < columnX("escalade"), "en route");
    advance(3);
    near(x(api), columnX("escalade"));
  });

  test("une cible modifiée en cours de route : le post-it repart de là où il est, sans téléportation", () => {
    const { api } = setup();
    api.update(start);
    const advance = clockOf(api);
    advance(0.1);
    api.update(moved.model, moved.transitions);
    advance(0.3);
    const inFlight = x(api);
    const back = apply(moved.model, evt("feature.status", 2, { issue: 7, status: "in-test" }));
    api.update(back.model, back.transitions);
    advance(1 / 60);
    assert.ok(Math.abs(x(api) - inFlight) < 1, `repart de la position affichée : ${inFlight} -> ${x(api)}`);
    advance(3);
    near(x(api), columnX("test"));
  });
});

describe("pick : de l'écran au post-it (correspondance instance -> feature)", () => {
  function screenPoint(api, position, size = { width: 800, height: 600 }) {
    api.camera.updateMatrixWorld();
    const ndc = new THREE.Vector3(position.x, position.y, position.z).project(api.camera);
    return { x: ((ndc.x + 1) / 2) * size.width, y: ((1 - ndc.y) / 2) * size.height };
  }

  test("cliquer sur un post-it rend cette feature, ailleurs rend null", () => {
    const { api } = setup({ width: 1600, height: 900 });
    const next = modelOf([feature(1, "ready", { title: "Un" }), feature(2, "in-progress", { title: "Deux" }), feature(3, "in-review", { title: "Trois" })]);
    api.update(next);
    run(api, 0.05);
    const target = kanbanLayout(next).notes.find((n) => n.number === 2);
    // La caméra se rapproche, face au kanban.
    api.camera.position.set(target.x, target.y, target.z + 8);
    api.camera.lookAt(target.x, target.y, target.z);
    api.camera.updateMatrixWorld();

    const at = screenPoint(api, target, { width: 1600, height: 900 });
    const hit = api.pick(at.x, at.y);
    assert.equal(hit.number, 2);
    assert.equal(hit.title, "Deux");
    assert.equal(api.pick(5, 5), null, "le coin de l'écran ne touche aucun post-it");
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
    const api = createScene({ container, renderer, window: fakeWindow(), loadModel: fakeLoader(THREE) });
    api.update(modelOf([feature(1, "ready")]));
    assert.equal(api.pick(10, 10), null);
  });
});

describe("points d'extension : onFrame, addLayer, onUpdate", () => {
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
