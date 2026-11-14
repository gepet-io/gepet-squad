// Tests de viz/public/js/characters.js : rendu des bonhommes décidés par crew.js, sous Node (pas de WebGL), avec les
// crochets `three-register.mjs` et un faux chargeur glTF qui rend de vrais clips d'animation. Le graphe Three.js est réel
// (clones, AnimationMixer, CSS2DObject) ; seuls le rendu final et la lecture des fichiers .glb sont simulés.
import "./three-register.mjs";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { init, apply } from "../../viz/public/js/state.js";
import { ASSETS } from "../../viz/public/js/assets.js";
import { AGENT_DEFAULT_COLOR, agentColor } from "../../viz/public/js/motion.js";
import { MAX_DEV_SEATS, OFFICE, devSeat, waypoints } from "../../viz/public/js/office-layout.js";
import { stepCrew } from "../../viz/public/js/crew.js";
import { fakeContainer, fakeElement, fakeRenderer, fakeWindow } from "./dom-fakes.mjs";
import { agent, evt, feature, stateOf } from "./support.mjs";

let THREE;
let createScene;
let createCharacters;
let capsuleColor;
let clipAction;
let folderPlacement;
let FADE_SECONDS;
before(async () => {
  THREE = await import("three");
  ({ createScene } = await import("../../viz/public/js/scene.js"));
  ({ createCharacters, capsuleColor, clipAction, folderPlacement, FADE_SECONDS } = await import("../../viz/public/js/characters.js"));
});

const CLIPS = ["idle", "walk", "sit", "interact-right", "emote-yes", "emote-no", "holding-both"];

// Document dont les éléments se laissent retirer comme dans un navigateur (voir labels.test.mjs).
function removableDocument() {
  const view = { Element: { [Symbol.hasInstance]: () => true } };
  return { createElement: (tag) => fakeElement(tag, { ownerDocument: { defaultView: view, addEventListener() {}, removeEventListener() {} } }) };
}

// Faux chargeur : un modèle d'un maillage avec tous les clips (une piste sur la position), et un journal des appels.
function loader({ fail = [], log = [] } = {}) {
  const load = async (url) => {
    log.push(url);
    if (fail.some((part) => url.includes(part))) throw new Error(`chargement impossible : ${url}`);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    const animations = CLIPS.map((name) => new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack(".position[x]", [0, 1], [0, 1])]));
    return { scene: root, animations };
  };
  load.log = log;
  return load;
}

async function setup({ loadModel = loader(), failed = [] } = {}) {
  const doc = removableDocument();
  const win = fakeWindow();
  const api = createScene({ container: fakeContainer(), renderer: fakeRenderer(), window: win, loadModel: loader() });
  const characters = createCharacters(api, { loadModel, document: doc, onAssetsFailed: (count, ids) => failed.push([count, ids]) });
  await characters.ready;
  return { api, characters, win, loadModel, failed };
}

const STATION = { developpeur: "dev", verificateur: "verification", testeur: "test" };
const A = (id, type, extra = {}) => agent(id, { type, station: STATION[type], ...extra });
const T0 = 1_000_000;
const STEP = 16;
// Fait tourner `characters` de `from` à `to` ms (images de 16 ms).
function run(characters, from, to) {
  for (let t = from; t <= to; t += STEP) characters.frame(STEP / 1000, t / 1000);
}
// Idem, et renvoie la suite des clips successifs de `id` (`null` : bonhomme absent).
function seen(characters, id, from, to, clips = []) {
  for (let t = from; t <= to; t += STEP) {
    characters.frame(STEP / 1000, t / 1000);
    const clip = characters.entry(id)?.clip ?? null;
    if (clips.at(-1) !== clip) clips.push(clip);
  }
  return clips;
}

describe("fonctions pures", () => {
  test("capsuleColor : la couleur du type d'agent (motion.js), grise pour un type inconnu", () => {
    for (const role of ["architecte", "developpeur", "verificateur", "testeur"]) assert.equal(capsuleColor(role), agentColor(role));
    assert.notEqual(capsuleColor("developpeur"), capsuleColor("testeur"));
    assert.equal(capsuleColor("inconnu"), AGENT_DEFAULT_COLOR);
  });

  test("clipAction : garde, change (fondu) ou fige selon le clip et le mode réduit", () => {
    assert.equal(clipAction(null, false, "walk", false), "switch");
    assert.equal(clipAction("walk", false, "sit", false), "switch");
    assert.equal(clipAction("walk", false, "walk", false), "keep");
    assert.equal(clipAction("walk", false, "walk", true), "freeze");
    assert.equal(clipAction("walk", true, "walk", false), "thaw");
    assert.equal(clipAction("walk", true, "walk", true), "keep");
  });

  test("folderPlacement : devant le poste, sur le bureau (assis) ou au sol (debout)", () => {
    const seated = folderPlacement({ x: 0, z: 10 }, Math.PI, true);
    assert.ok(seated.z < 10, "devant un bonhomme tourné vers -z");
    assert.ok(seated.y > 0.75, "au-dessus du plateau du bureau");
    assert.ok(folderPlacement({ x: 0, z: 10 }, Math.PI, false).y < 0.1);
  });
});

describe("chargement", () => {
  test("chaque fichier de personnage est chargé une seule fois, même avec plusieurs bonhommes du même modèle", async () => {
    const loadModel = loader();
    const { api, characters } = await setup({ loadModel });
    api.update(init(stateOf({ agents: [A("d1", "developpeur"), A("d2", "developpeur")] })));
    run(characters, T0, T0 + 200);
    assert.equal(loadModel.log.filter((u) => u.includes("characters/")).length, ASSETS.characters.length);
    for (const asset of ASSETS.characters) assert.equal(loadModel.log.filter((u) => u === asset.path).length, 1, asset.path);
  });

  test("chaque bonhomme est un clone distinct avec son propre mixer, qui partage la géométrie du modèle", async () => {
    const { api, characters } = await setup();
    // d0 et d3 : les postes 0 et 3 ont le même modèle (trois modèles de développeur, en rotation)
    api.update(init(stateOf({ agents: [0, 1, 2, 3].map((i) => A(`d${i}`, "developpeur")).concat(A("v1", "verificateur")) })));
    run(characters, T0, T0 + 200);
    const [d1, d2, v1, pm] = ["d0", "d3", "v1", "pm"].map((id) => characters.entry(id));
    assert.ok(d1.mixer && v1.mixer && pm.mixer);
    assert.notEqual(d1.mixer, v1.mixer);
    assert.notEqual(d1.visual, d2.visual);
    assert.equal(d1.visual.children[0].geometry, d2.visual.children[0].geometry, "même modèle d'origine");
    assert.notEqual(d1.visual.children[0], d2.visual.children[0], "mais clones distincts");
    assert.notEqual(d1.visual.children[0].geometry, characters.entry("d1").visual.children[0].geometry, "un autre modèle : un autre fichier");
  });
});

describe("suite d'états : entrer, travailler, rendre un verdict, sortir", () => {
  test("clips dans l'ordre, bulle et dossier créés puis retirés, bonhomme retiré à gone", async () => {
    const { api, characters } = await setup();
    const running = A("d1", "developpeur", { issue: 7, phase: "running" });
    api.update(init(stateOf({ agents: [running] })));
    const clips = seen(characters, "d1", T0, T0 + 5000);
    assert.deepEqual(clips.slice(0, 3), ["walk", "sit", "interact-right"]);
    const rec = characters.entry("d1");
    assert.equal(rec.folder.label.element.textContent, "#7");
    assert.ok(rec.folder.children.some((o) => o.isMesh && o.geometry.type === "BoxGeometry"), "dossier : une boîte");
    assert.equal(rec.bubble, null);
    assert.ok(characters.group.children.includes(rec.group));

    // rapport : bulle de verdict, clip emote-yes
    const reported = { ...running, phase: "reported", verdict: "LIVRÉ", block: "RAPPORT_DEV" };
    api.update({ ...api.model(), agents: [reported] });
    const reporting = seen(characters, "d1", T0 + 5100, T0 + 5300);
    assert.equal(reporting.at(-1), "emote-yes");
    assert.equal(rec.bubble.element.textContent, "LIVRÉ");
    assert.ok(rec.group.children.includes(rec.bubble));

    // la bulle disparaît après 4 s, le bonhomme se rassied
    seen(characters, "d1", T0 + 5300, T0 + 5100 + 4300);
    assert.equal(rec.bubble, null);
    assert.equal(rec.clip, "sit");

    // sortie : walk, puis retiré de la scène, mixer libéré, dossier retiré
    const mixer = rec.mixer;
    let stopped = 0;
    const stopAll = mixer.stopAllAction.bind(mixer);
    mixer.stopAllAction = () => {
      stopped += 1;
      stopAll();
    };
    api.update({ ...api.model(), agents: [{ ...reported, phase: "finished" }] });
    const leaving = seen(characters, "d1", T0 + 10000, T0 + 10100);
    assert.equal(leaving[0], "walk");
    seen(characters, "d1", T0 + 10100, T0 + 14000);
    assert.equal(characters.entry("d1"), undefined);
    assert.equal(characters.group.children.includes(rec.group), false);
    assert.equal(rec.folder, null);
    assert.equal(stopped, 1, "mixer libéré");
    assert.equal(rec.mixer, null);
  });

  test("position et cap suivent exactement crew.js à chaque image", async () => {
    const { api, characters } = await setup();
    const model = init(stateOf({ agents: [A("d1", "developpeur", { phase: "running" })] }));
    api.update(model);
    let expected = [];
    for (let t = T0; t < T0 + 2500; t += STEP) {
      expected = stepCrew(expected, model, [], t, false);
      characters.frame(STEP / 1000, t / 1000);
      const want = expected.find((b) => b.id === "d1");
      const got = characters.entry("d1").group;
      assert.equal(got.position.x, want.position.x);
      assert.equal(got.position.z, want.position.z);
      assert.equal(got.rotation.y, want.heading);
    }
  });

  test("le chef de projet est présent dès la première image, assis à son bureau", async () => {
    const { api, characters } = await setup();
    api.update(init(stateOf({ agents: [] })));
    run(characters, T0, T0 + 100);
    assert.equal(characters.entry("pm").clip, "sit");
    assert.equal(characters.entry("pm").group.position.x, OFFICE.pm.x);
  });

  test("un changement de clip fait un fondu croisé de 0,2 s : l'ancien clip s'estompe, le nouveau s'impose", async () => {
    const { api, characters } = await setup();
    api.update(init(stateOf({ agents: [A("d1", "developpeur", { phase: "running" })] })));
    let changedAt = null;
    let walk = null;
    let sit = null;
    let last = null;
    for (let t = T0; t < T0 + 5000; t += STEP) {
      characters.frame(STEP / 1000, t / 1000);
      const rec = characters.entry("d1");
      if (rec.clip === "sit" && last === "walk") {
        changedAt = t;
        walk = rec.actions.get("walk");
        sit = rec.actions.get("sit");
        assert.ok(walk.getEffectiveWeight() > 0.9, "l'ancien clip pèse encore juste après le changement");
      }
      last = rec.clip;
      if (changedAt !== null && t >= changedAt + 250) break;
    }
    assert.ok(changedAt !== null);
    assert.equal(FADE_SECONDS, 0.2);
    assert.ok(walk.getEffectiveWeight() < 1e-6, "ancien clip estompé après 0,2 s");
    assert.ok(sit.getEffectiveWeight() > 0.99, "nouveau clip à plein poids");
  });
});

describe("mode réduit", () => {
  test("aucune marche, et le clip est figé sur sa première image (le mixer n'avance plus)", async () => {
    const { api, characters, win } = await setup();
    win.media.reduced = true;
    api.update(init(stateOf({ agents: [A("d1", "developpeur", { phase: "running" })] })));
    const clips = seen(characters, "d1", T0, T0 + 2000);
    assert.ok(!clips.includes("walk"));
    const rec = characters.entry("d1");
    assert.equal(rec.frozen, true);
    assert.equal(rec.action.paused, true);
    run(characters, T0 + 2000, T0 + 3000);
    assert.equal(rec.action.time, 0);
  });

  test("sans mode réduit, le clip avance ; le repasser en mode normal le relance", async () => {
    const { api, characters, win } = await setup();
    api.update(init(stateOf({ agents: [A("d1", "developpeur", { phase: "running" })] })));
    seen(characters, "d1", T0, T0 + 4500);
    const rec = characters.entry("d1");
    assert.equal(rec.clip, "interact-right");
    const before = rec.action.time;
    run(characters, T0 + 4500, T0 + 4700);
    assert.notEqual(rec.action.time, before);
    assert.equal(rec.action.paused, false);
    win.media.reduced = true;
    run(characters, T0 + 4700, T0 + 4800);
    assert.equal(rec.action.paused, true);
    assert.equal(rec.action.time, 0);
    win.media.reduced = false;
    run(characters, T0 + 4800, T0 + 5000);
    assert.equal(rec.action.paused, false);
  });
});

describe("modèle qui ne se charge pas", () => {
  test("capsule colorée selon le type d'agent, avertissement une seule fois, la scène continue", async () => {
    const failed = [];
    const { api, characters } = await setup({ loadModel: loader({ fail: ["character-male-a", "character-female-c"] }), failed });
    assert.equal(failed.length, 1);
    assert.equal(failed[0][0], 2);
    assert.deepEqual(failed[0][1], ["character-female-c", "character-male-a"]);
    api.update(init(stateOf({ agents: [A("d1", "developpeur", { phase: "running" }), A("v1", "verificateur", { phase: "running" })] })));
    run(characters, T0, T0 + 3000);
    const d1 = characters.entry("d1");
    assert.equal(d1.visual.geometry.type, "CapsuleGeometry");
    assert.equal(d1.visual.material.color.getHex(), agentColor("developpeur"));
    assert.equal(d1.mixer, null);
    assert.equal(characters.entry("v1").visual.material.color.getHex(), agentColor("verificateur"));
    assert.ok(characters.entry("pm").mixer, "les modèles chargés restent des bonhommes animés");
    run(characters, T0 + 3000, T0 + 3200);
    assert.equal(failed.length, 1, "un seul avertissement");
  });
});

describe("poste supplémentaire", () => {
  test("ses meubles sont ajoutés quand il est occupé, retirés quand il se libère", async () => {
    const { api, characters } = await setup();
    const devs = [0, 1, 2, 3].map((i) => A(`d${i}`, "developpeur", { phase: "running" }));
    api.update(init(stateOf({ agents: devs.slice(0, 3) })));
    run(characters, T0, T0 + 200);
    assert.equal(characters.extraSeats.size, 0, "les 3 postes par défaut n'ajoutent aucun meuble");
    api.update({ ...api.model(), agents: devs });
    run(characters, T0 + 200, T0 + 400);
    assert.deepEqual([...characters.extraSeats.keys()], [3]);
    const group = characters.extraSeats.get(3);
    assert.equal(group.children.length, devSeat(3).furniture.length);
    assert.ok(characters.group.children.includes(group));
    // le développeur 3 finit puis repart : le poste est libéré
    api.update({ ...api.model(), agents: [...devs.slice(0, 3), { ...devs[3], phase: "finished" }] });
    run(characters, T0 + 400, T0 + 7000);
    assert.equal(characters.extraSeats.size, 0);
    assert.equal(characters.group.children.includes(group), false);
  });

  test("les 8 postes de développeur existent, seuls ceux au-delà de 3 sont supplémentaires", () => {
    assert.equal(MAX_DEV_SEATS, 8);
    assert.equal(devSeat(2).extra, false);
    assert.equal(devSeat(3).extra, true);
    assert.ok(waypoints()["dev:3"]);
  });
});

describe("texte et nettoyage", () => {
  test("bulle écrite par textContent : du HTML s'affiche tel quel", async () => {
    const { api, characters } = await setup();
    const xss = '<img src=x onerror="document.title=1">';
    api.update(init(stateOf({ agents: [A("d1", "developpeur", { phase: "reported", verdict: xss, issue: 3 })] })));
    run(characters, T0, T0 + 3600);
    assert.equal(characters.entry("d1").bubble.element.textContent, xss);
  });

  test("la bulle retirée emporte son élément du DOM ; dispose retire la couche et les bonhommes", async () => {
    const { api, characters } = await setup();
    api.update(init(stateOf({ agents: [A("d1", "developpeur", { phase: "reported", verdict: "PASS" })] })));
    run(characters, T0, T0 + 3600);
    const bubble = characters.entry("d1").bubble;
    assert.equal(bubble.element.removed, false);
    run(characters, T0 + 3600, T0 + 9000);
    assert.equal(bubble.element.removed, true);
    characters.dispose();
    assert.equal(api.scene.children.includes(characters.group), false);
    assert.equal(characters.entries.size, 0);
  });

  test("repris après un état gone : le bonhomme revient et rejoue ses clips", async () => {
    const { api, characters } = await setup();
    const a = A("d1", "developpeur", { phase: "running" });
    api.update(init(stateOf({ agents: [a] })));
    run(characters, T0, T0 + 4000);
    api.update({ ...api.model(), agents: [{ ...a, phase: "finished" }] });
    run(characters, T0 + 4000, T0 + 9000);
    assert.equal(characters.entry("d1"), undefined);
    api.update({ ...api.model(), agents: [a] });
    const clips = seen(characters, "d1", T0 + 9000, T0 + 13000);
    assert.deepEqual(clips.slice(0, 2), ["walk", "sit"]);
  });
});

test("les transitions (geste du chef de projet) ne sont vues qu'une fois par crew.js", async () => {
  const { api, characters } = await setup();
  const m0 = init(stateOf({ agents: [], features: [feature(1, "in-progress")] }));
  api.update(m0);
  run(characters, T0, T0 + 100);
  assert.equal(characters.entry("pm").clip, "sit");
  const result = apply(m0, evt("feature.status", 10, { issue: 1, status: "in-review" }));
  assert.ok(result.transitions.some((t) => t.kind === "feature-move" || t.kind === "feature-status"), JSON.stringify(result.transitions));
  api.update(result.model, result.transitions);
  const clips = seen(characters, "pm", T0 + 200, T0 + 3000);
  assert.deepEqual(clips, ["interact-right", "sit"]);
});

describe("main.js : loadCharacters", () => {
  test("branche les bonhommes sur la scène (module chargé à la demande)", async () => {
    const { loadCharacters } = await import("../../viz/public/js/main.js");
    const api = createScene({ container: fakeContainer(), renderer: fakeRenderer(), window: fakeWindow(), loadModel: loader() });
    const warnings = [];
    const win = { console: { warn: (m) => warnings.push(m) } };
    const warning = fakeElement("p", { hidden: true });
    const doc = { createElement: (tag) => fakeElement(tag), getElementById: (id) => (id === "avertissement" ? warning : null) };
    const before = new Set(api.scene.children);
    await loadCharacters(api, win, doc);
    assert.equal(api.scene.children.filter((o) => !before.has(o)).length, 1, "la couche des bonhommes est ajoutée");
    assert.deepEqual(warnings, []);
  });

  test("n'interrompt pas la page si la couche échoue : l'erreur est signalée", async () => {
    const { loadCharacters } = await import("../../viz/public/js/main.js");
    const warnings = [];
    await loadCharacters({}, { console: { warn: (m) => warnings.push(m) } }, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bonhommes indisponibles/);
  });
});
