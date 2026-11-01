// Tests de viz/public/js/agents.js et du branchement de motion.js dans scene.js, avec un moteur de rendu factice (pas de
// WebGL) : le graphe Three.js est réel (scène, InstancedMesh, entités, CSS2DObject, EffectComposer et ses passes), seul
// le rendu final est simulé. Les transitions viennent de `state.js` (`apply`), pas de données écrites à la main.
import "./three-register.mjs";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { apply, init } from "../../viz/public/js/state.js";
import { escaladeBox, boxContains, layoutAgents, layoutFeatures } from "../../viz/public/js/layout.js";
import { AGENT_COLORS, BLOOM, easeInOutCubic, FADE_SECONDS, GLOW_LUMINANCE, PULSE_PERIOD_SECONDS, agentColor, agentLook, glowScale, moveDuration, retryBadgeText } from "../../viz/public/js/motion.js";
import { fakeContainer, fakeDocument, fakeElement, fakeRenderer, fakeWindow } from "./dom-fakes.mjs";
import { agent, evt, feature, stateOf } from "./support.mjs";

let THREE;
let createScene;
let createAgents;
let createBloomComposer;
let loadAgents;
let boot;
before(async () => {
  THREE = await import("three");
  ({ createScene } = await import("../../viz/public/js/scene.js"));
  ({ createAgents, createBloomComposer } = await import("../../viz/public/js/agents.js"));
  ({ loadAgents, boot } = await import("../../viz/public/js/main.js"));
});

// Document dont les éléments se laissent retirer comme dans un navigateur : le `removed` de CSS2DObject appelle
// `element instanceof element.ownerDocument.defaultView.Element`.
function badgeDocument() {
  const view = { Element: { [Symbol.hasInstance]: () => true } };
  return {
    createElement(tag) {
      return fakeElement(tag, { ownerDocument: { defaultView: view, addEventListener() {}, removeEventListener() {} } });
    },
  };
}

// Le vrai compositeur (passes réelles), dont le dernier maillon GL est remplacé : sans WebGL, `render` ne peut pas tourner.
const stubbed = (sceneApi) => {
  const composer = createBloomComposer(sceneApi);
  composer.render = () => {};
  return composer;
};

function setup({ reduced = false, createComposer = null, document: doc = badgeDocument(), warn = () => {} } = {}) {
  const container = fakeContainer(800, 600);
  const renderer = fakeRenderer({ width: 800, height: 600 });
  const win = fakeWindow(800, 600);
  win.media.reduced = reduced;
  const api = createScene({ container, renderer, window: win });
  const warnings = [];
  const agents = createAgents(api, { document: doc, createComposer, warn: (message) => { warnings.push(message); warn(message); } });
  let t = 1000;
  api.frame(t);
  // Fait avancer la boucle de `seconds` secondes à 60 images par seconde.
  const run = (seconds, fps = 60) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) api.frame((t += 1000 / fps));
  };
  return { api, agents, renderer, win, run, warnings };
}

const modelOf = (features, agentList = []) => init(stateOf({ features, agents: agentList }));
const entityOf = (agents, id) => agents.entities.get(id);
const color = (entity) => entity.material.color.getHex();
const mesh = (api) => api.scene.children.find((o) => o.isInstancedMesh);
const featureX = (api, index = 0) => new THREE.Vector3().setFromMatrixPosition(mesh(api).getMatrixAt(index, new THREE.Matrix4())).x;
const featureAt = (api, index = 0) => new THREE.Vector3().setFromMatrixPosition(mesh(api).getMatrixAt(index, new THREE.Matrix4()));
const near = (a, b, eps = 1e-3, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} != ${b}`);

describe("déplacement des features : interpolation décidée par motion.js", () => {
  const start = modelOf([feature(7, "in-progress")]);
  const moved = apply(start, evt("feature.status", 1, { issue: 7, status: "in-review" }));

  test("la transition de state.js est une feature-move dev -> verification", () => {
    assert.deepEqual(moved.transitions.filter((t) => t.kind === "feature-move"), [{ kind: "feature-move", id: 7, from: "dev", to: "verification" }]);
  });

  test("la feature part de sa position, passe par le milieu à mi-durée et arrive pile à la cible, à l'heure dite", () => {
    const { api, run } = setup();
    api.update(start);
    run(0.2);
    const from = layoutFeatures(start).get(7);
    const to = layoutFeatures(moved.model).get(7);
    near(featureX(api), from.x, 1e-3);

    api.update(moved.model, moved.transitions);
    const duration = moveDuration(from, to, "move");
    assert.ok(duration > 0.7 && duration < 1.8, "durée proportionnelle à la distance, bornée");

    run(0.1);
    const early = featureX(api);
    assert.ok(early > from.x && early < from.x + 0.1 * (to.x - from.x), `départ doux : ${early}`);

    // Image par image (60 Hz) : la position affichée suit exactement la courbe de motion.js au temps écoulé.
    const frames = Math.round((duration / 2 - 0.1) * 60);
    run(duration / 2 - 0.1);
    const elapsed = (Math.round(0.1 * 60) + frames) / 60;
    near(featureX(api), from.x + (to.x - from.x) * easeInOutCubic(elapsed / duration), 0.01, "position = courbe au temps écoulé");
    near(featureX(api), (from.x + to.x) / 2, 1, "à peu près à mi-chemin à mi-durée");

    run(duration / 2 - 0.1);
    assert.ok(featureX(api) < to.x, "pas encore arrivée juste avant la fin");
    run(0.3);
    const end = featureAt(api);
    near(end.x, to.x, 1e-4);
    near(end.y, to.y, 1e-4);
    near(end.z, to.z, 1e-4);
  });

  test("le mouvement est continu : jamais plus d'un quart du trajet d'une image à l'autre", () => {
    const { api, run } = setup();
    api.update(start);
    run(0.1);
    const from = layoutFeatures(start).get(7);
    const to = layoutFeatures(moved.model).get(7);
    api.update(moved.model, moved.transitions);
    let previous = featureX(api);
    for (let i = 0; i < 120; i++) {
      run(1 / 60);
      const x = featureX(api);
      assert.ok(x >= previous - 1e-9, "ne recule jamais");
      assert.ok(x - previous < (to.x - from.x) / 4, `saut de ${x - previous}`);
      previous = x;
    }
  });

  test("prefers-reduced-motion : la feature est à sa cible dès l'image suivante, sans glissement", () => {
    const { api, run } = setup({ reduced: true });
    api.update(start);
    run(0.1);
    api.update(moved.model, moved.transitions);
    run(1 / 60);
    near(featureX(api), layoutFeatures(moved.model).get(7).x, 1e-4);
  });

  test("la préférence est relue à chaque image : activée en plein déplacement, la feature se pose aussitôt", () => {
    const { api, run, win } = setup();
    api.update(start);
    run(0.1);
    api.update(moved.model, moved.transitions);
    run(0.2);
    const to = layoutFeatures(moved.model).get(7);
    assert.ok(featureX(api) < to.x - 1);
    win.media.reduced = true;
    run(1 / 60);
    near(featureX(api), to.x, 1e-4);
  });

  test("une feature bloquée glisse dans la zone d'escalade rouge accolée à sa station", () => {
    const { api, run } = setup();
    api.update(start);
    run(0.1);
    const blocked = apply(start, evt("feature.status", 1, { issue: 7, status: "blocked" }));
    assert.deepEqual(blocked.transitions.filter((t) => t.kind === "feature-move"), [{ kind: "feature-move", id: 7, from: "dev", to: "escalade" }]);
    api.update(blocked.model, blocked.transitions);
    run(0.2);
    const zone = escaladeBox("dev");
    assert.equal(boxContains(zone, featureAt(api)), false, "encore en route");
    run(2);
    assert.equal(boxContains(zone, featureAt(api)), true, "arrivée dans la zone d'escalade de la station dev");
    assert.ok(featureAt(api).z < -8);
  });

  test("une cible modifiée en cours de route : la feature repart de là où elle est, sans téléportation", () => {
    const { api, run } = setup();
    api.update(start);
    run(0.1);
    api.update(moved.model, moved.transitions);
    run(0.4);
    const inFlight = featureX(api);
    const back = apply(moved.model, evt("feature.status", 2, { issue: 7, status: "in-test" }));
    api.update(back.model, back.transitions);
    run(1 / 60);
    assert.ok(Math.abs(featureX(api) - inFlight) < 1, `repart de la position affichée : ${inFlight} -> ${featureX(api)}`);
    run(3);
    near(featureX(api), layoutFeatures(back.model).get(7).x, 1e-4);
  });
});

describe("rendu avec bloom : EffectComposer + RenderPass + UnrealBloomPass + OutputPass", () => {
  test("le compositeur par défaut enchaîne RenderPass, UnrealBloomPass puis OutputPass, avec les réglages de motion.js", () => {
    const { api } = setup();
    const composer = createBloomComposer(api);
    assert.equal(composer.constructor.name, "EffectComposer");
    assert.deepEqual(composer.passes.map((p) => p.constructor.name), ["RenderPass", "UnrealBloomPass", "OutputPass"]);
    const [render, bloom] = composer.passes;
    assert.equal(render.scene, api.scene);
    assert.equal(render.camera, api.camera);
    assert.equal(bloom.strength, BLOOM.strength);
    assert.equal(bloom.radius, BLOOM.radius);
    assert.equal(bloom.threshold, BLOOM.threshold);
    assert.equal(composer.renderTarget1.samples, 4, "anticrénelage conservé");
    assert.equal(composer.renderTarget1.texture.type, THREE.HalfFloatType, "rendu en HDR");
  });

  test("avec un compositeur, chaque image passe par composer.render(delta) à la place de renderer.render", () => {
    const calls = [];
    const { api, renderer, run } = setup({
      createComposer: (sceneApi) => {
        const composer = createBloomComposer(sceneApi);
        composer.render = (delta) => calls.push(delta);
        return composer;
      },
    });
    assert.equal(calls.length, 1, "l'image d'initialisation est déjà passée par le compositeur");
    assert.equal(renderer.renders, 0, "le rendu direct n'est pas utilisé");
    calls.length = 0;
    run(0.1);
    assert.equal(calls.length, 6);
    assert.equal(renderer.renders, 0);
    assert.ok(calls.every((d) => d > 0 && d <= 0.1));
    assert.ok(api.size().width > 0);
  });

  test("un redimensionnement de la vue redimensionne le compositeur et ses passes", () => {
    const { api, agents } = setup({ createComposer: stubbed });
    api.resize(1280, 720);
    const composer = agents.composer;
    assert.equal(composer.renderTarget1.width, 1280);
    assert.equal(composer.renderTarget1.height, 720);
    assert.equal(composer.passes[0].constructor.name, "RenderPass");
  });

  test("si le rendu en HDR échoue, la scène revient au rendu direct (agents compris) et l'avertit une fois", () => {
    let disposed = 0;
    const { renderer, run, warnings } = setup({
      createComposer: () => ({
        render() {
          throw new Error("pas de rendu flottant");
        },
        setSize() {},
        dispose() {
          disposed += 1;
        },
      }),
    });
    const before = renderer.renders;
    run(0.05);
    assert.equal(renderer.renders - before, 3, "chaque image est quand même rendue, en direct");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bloom désactivé : pas de rendu flottant/);
    assert.equal(disposed, 1);
  });

  test("sans compositeur (null) ou si sa création échoue, le rendu direct reste en place", () => {
    const direct = setup({ createComposer: null });
    const before = direct.renderer.renders;
    direct.run(0.05);
    assert.equal(direct.renderer.renders - before, 3);

    const failing = setup({
      createComposer: () => {
        throw new Error("contexte perdu");
      },
    });
    const start = failing.renderer.renders;
    failing.run(0.05);
    assert.equal(failing.renderer.renders - start, 3);
    assert.match(failing.warnings[0], /bloom indisponible, agents sans halo : contexte perdu/);
    assert.equal(failing.agents.composer, null);
  });
});

describe("agents : une entité lumineuse par agent", () => {
  const types = ["architecte", "developpeur", "verificateur", "testeur"];
  const agentList = types.map((type, i) => agent(`a${i}`, { type, phase: "running", issue: null, station: type === "architecte" ? "cadrage" : "dev" }));

  test("chaque agent a une entité dont la couleur dépend de son type, en HDR, hors de la palette des statuts", () => {
    const { api, agents } = setup();
    api.update(modelOf([], agentList));
    assert.equal(agents.entities.size, 4);
    const colors = new Set();
    types.forEach((type, i) => {
      const expected = new THREE.Color().setHex(AGENT_COLORS[type]).multiplyScalar(glowScale(AGENT_COLORS[type]));
      assert.equal(color(entityOf(agents, `a${i}`)), expected.getHex(), type);
      colors.add(color(entityOf(agents, `a${i}`)));
      assert.ok(agents.group.children.includes(entityOf(agents, `a${i}`).mesh));
    });
    assert.equal(colors.size, 4, "quatre couleurs distinctes");
    const dev = entityOf(agents, "a1").material.color;
    assert.ok(Math.max(dev.r, dev.g, dev.b) > 1, "au-dessus de 1 : c'est ce qui allume le bloom");
    assert.equal(entityOf(agents, "a1").material.toneMapped, false);
  });

  test("la luminance à l'écran d'un agent plein vaut GLOW_LUMINANCE, au-dessus du seuil du bloom", () => {
    const { api, agents } = setup();
    api.update(modelOf([], [agent("x", { type: "testeur" })]));
    const c = entityOf(agents, "x").material.color;
    const luminance = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    near(luminance, GLOW_LUMINANCE, 1e-3);
    assert.ok(luminance > BLOOM.threshold);
  });

  test("un type d'agent inconnu prend la couleur neutre", () => {
    const { api, agents } = setup();
    api.update(modelOf([], [agent("x", { type: "mystere" })]));
    const expected = new THREE.Color().setHex(agentColor("mystere")).multiplyScalar(glowScale(agentColor("mystere")));
    assert.equal(color(entityOf(agents, "x")), expected.getHex());
  });

  test("l'opacité suit la phase : requested, running et reported vivent ; unknown est atténué", () => {
    const { api, agents, run } = setup();
    api.update(modelOf([], ["requested", "running", "reported", "unknown"].map((phase) => agent(phase, { phase }))));
    run(FADE_SECONDS + 0.2);
    for (const phase of ["requested", "running", "reported", "unknown"]) {
      const entity = entityOf(agents, phase);
      near(entity.material.opacity, agentLook(phase).opacity, 1e-9, phase);
      assert.equal(entity.mesh.visible, true, phase);
    }
    assert.ok(entityOf(agents, "unknown").material.opacity < entityOf(agents, "reported").material.opacity);
    assert.equal(entityOf(agents, "running").material.transparent, true);
  });

  test("un agent qui apparaît s'allume en fondu, il n'est pas plein dès la première image", () => {
    const { api, agents, run } = setup();
    api.update(modelOf([], [agent("a", { phase: "running" })]));
    run(1 / 60);
    const first = entityOf(agents, "a").material.opacity;
    assert.ok(first > 0 && first < 0.1, `première image : ${first}`);
    run(FADE_SECONDS);
    assert.equal(entityOf(agents, "a").material.opacity, 1);
  });

  test("un agent finished disparaît en fondu, puis n'est plus dessiné ; un agent déjà terminé n'apparaît pas", () => {
    const { api, agents, run } = setup();
    const running = modelOf([], [agent("a", { phase: "running" })]);
    api.update(running);
    run(FADE_SECONDS + 0.1);
    assert.equal(entityOf(agents, "a").material.opacity, 1);

    api.update(modelOf([], [agent("a", { phase: "finished", finishedAt: "2026-10-30T10:01:00.000Z" })]));
    run(FADE_SECONDS / 2);
    const half = entityOf(agents, "a");
    assert.ok(half.material.opacity > 0.3 && half.material.opacity < 0.7, `mi-fondu : ${half.material.opacity}`);
    assert.equal(half.mesh.visible, true, "encore visible pendant le fondu");
    run(FADE_SECONDS / 2 + 0.1);
    assert.equal(half.material.opacity, 0);
    assert.equal(half.mesh.visible, false);

    api.update(modelOf([], [agent("b", { phase: "finished", finishedAt: "2026-10-30T10:01:00.000Z" })]));
    run(1 / 60);
    assert.equal(entityOf(agents, "b").mesh.visible, false, "jamais allumé");
  });

  test("prefers-reduced-motion : apparition et disparition immédiates", () => {
    const { api, agents, run } = setup({ reduced: true });
    api.update(modelOf([], [agent("a", { phase: "running" })]));
    run(1 / 60);
    assert.equal(entityOf(agents, "a").material.opacity, 1);
    api.update(modelOf([], [agent("a", { phase: "finished", finishedAt: "2026-10-30T10:01:00.000Z" })]));
    run(1 / 60);
    assert.equal(entityOf(agents, "a").mesh.visible, false);
  });

  test("un agent running pulse (échelle qui varie dans le temps) ; unknown et finished ne pulsent pas", () => {
    const { api, agents, run } = setup();
    api.update(modelOf([], [agent("run", { phase: "running" }), agent("unk", { phase: "unknown" })]));
    const scales = [];
    for (let i = 0; i < Math.round(PULSE_PERIOD_SECONDS * 60); i++) {
      run(1 / 60);
      scales.push(entityOf(agents, "run").mesh.scale.x);
      assert.equal(entityOf(agents, "unk").mesh.scale.x, 1);
    }
    const amplitude = agentLook("running").pulse;
    assert.ok(Math.max(...scales) > 1 + amplitude * 0.9, `maximum ${Math.max(...scales)}`);
    assert.ok(Math.min(...scales) < 1 - amplitude * 0.9, `minimum ${Math.min(...scales)}`);
    assert.ok(Math.max(...scales) <= 1 + amplitude + 1e-9);
  });

  test("prefers-reduced-motion : aucune pulsation", () => {
    const { api, agents, run } = setup({ reduced: true });
    api.update(modelOf([], [agent("run", { phase: "running" })]));
    for (let i = 0; i < 120; i++) {
      run(1 / 60);
      assert.equal(entityOf(agents, "run").mesh.scale.x, 1);
    }
  });

  test("les agents ne pulsent pas à l'unisson", () => {
    const { api, agents, run } = setup();
    api.update(modelOf([], [agent("alpha", { phase: "running" }), agent("omega", { phase: "running" })]));
    run(0.3);
    assert.notEqual(entityOf(agents, "alpha").mesh.scale.x, entityOf(agents, "omega").mesh.scale.x);
  });

  test("un agent disparaît du modèle : son entité est retirée de la scène et son matériau libéré", () => {
    const { api, agents, run } = setup();
    api.update(modelOf([], [agent("a"), agent("b")]));
    run(0.1);
    const gone = entityOf(agents, "a");
    let disposed = 0;
    gone.material.addEventListener("dispose", () => (disposed += 1));
    api.update(modelOf([], [agent("b")]));
    assert.equal(agents.entities.has("a"), false);
    assert.equal(agents.group.children.includes(gone.mesh), false);
    assert.equal(disposed, 1);
    assert.equal(agents.entities.size, 1);
  });

  test("les agents sont placés au-dessus de leur feature, et la suivent pendant son déplacement", () => {
    const start = modelOf([feature(7, "in-progress")], [agent("dev-7", { issue: 7, phase: "running" })]);
    const moved = apply(start, evt("feature.status", 1, { issue: 7, status: "in-review" }));
    const { api, agents, run } = setup();
    api.update(start);
    run(0.3);
    const home = layoutAgents(start, layoutFeatures(start)).get("dev-7");
    const entity = entityOf(agents, "dev-7");
    near(entity.mesh.position.x, home.x, 1e-6);
    near(entity.mesh.position.y, home.y, 1e-6);
    near(entity.mesh.position.z, home.z, 1e-6);

    api.update(moved.model, moved.transitions);
    const target = layoutAgents(moved.model, layoutFeatures(moved.model)).get("dev-7");
    run(0.5);
    const x = entity.mesh.position.x;
    assert.ok(x > home.x && x < target.x, "en route avec sa feature");
    assert.ok(x <= featureX(api) + 1e-9, "derrière ou sur la feature, jamais devant");
    run(3);
    near(entity.mesh.position.x, target.x, 1e-3);
    near(entity.mesh.position.y, target.y, 1e-3);
  });

  test("un agent sans feature survole sa station ; prefers-reduced-motion : il y est tout de suite", () => {
    const model = modelOf([], [agent("v", { type: "verificateur", station: "verification" })]);
    const { api, agents, run } = setup({ reduced: true });
    api.update(model);
    run(1 / 60);
    const expected = layoutAgents(model).get("v");
    const p = entityOf(agents, "v").mesh.position;
    assert.deepEqual([p.x, p.y, p.z], [expected.x, expected.y, expected.z]);
  });
});

describe("badges de retry (CSS2DObject, textContent)", () => {
  const badgeObjects = (agents) => agents.group.children.filter((o) => o.isCSS2DObject);

  test("une feature avec retry >= 1 porte un badge visible au-dessus d'elle ; sans retry, aucun", () => {
    const { api, agents, run } = setup();
    api.update(modelOf([feature(1, "in-progress", { retry: 2 }), feature(2, "in-progress", { retry: 0 }), feature(3, "in-review", { retry: 1 })]));
    run(1 / 60);
    assert.deepEqual([...agents.badges.keys()], [1, 3]);
    const badge = agents.badges.get(1);
    assert.equal(badge.element.textContent, retryBadgeText(2));
    assert.equal(agents.badges.get(3).element.textContent, "Retry 1");
    assert.equal(badge.element.className, "badge badge-retry");
    assert.equal(badge.visible, true);
    const p = api.positionOf(1);
    assert.deepEqual([badge.position.x, badge.position.z], [p.x, p.z]);
    assert.ok(badge.position.y > p.y, "au-dessus de la feature");
    assert.equal(badgeObjects(agents).length, 2);
  });

  test("le badge suit sa feature pendant son déplacement", () => {
    const start = modelOf([feature(7, "in-progress", { retry: 1 })]);
    const moved = apply(start, evt("feature.status", 1, { issue: 7, status: "in-review" }));
    const { api, agents, run } = setup();
    api.update(start);
    run(0.2);
    api.update(moved.model, moved.transitions);
    run(0.5);
    const badge = agents.badges.get(7);
    const p = api.positionOf(7);
    near(badge.position.x, p.x, 1e-9);
    assert.ok(badge.position.x > layoutFeatures(start).get(7).x, "il a quitté la station de départ");
  });

  test("le compteur change : le texte est mis à jour sur le même badge ; retry retombé à 0 : le badge est retiré du DOM", () => {
    const { api, agents, run } = setup();
    api.update(modelOf([feature(1, "in-progress", { retry: 1 })]));
    run(1 / 60);
    const badge = agents.badges.get(1);
    api.update(modelOf([feature(1, "in-progress", { retry: 3 })]));
    assert.equal(agents.badges.get(1), badge, "même objet");
    assert.equal(badge.element.textContent, "Retry 3");
    api.update(modelOf([feature(1, "in-progress", { retry: 0 })]));
    assert.equal(agents.badges.size, 0);
    assert.equal(agents.group.children.includes(badge), false);
    assert.equal(badge.element.removed, true, "l'élément quitte la couche d'étiquettes");
  });

  test("une feature qui n'est plus dessinée n'affiche plus son badge", () => {
    const { api, agents, run } = setup();
    api.update(modelOf([feature(1, "in-progress", { retry: 1 })]));
    run(1 / 60);
    api.update(modelOf([feature(1, "in-progress", { retry: 1, station: "inconnue" })]));
    api.update(modelOf([]));
    assert.equal(agents.badges.size, 0);
  });

  test("le badge ne passe jamais par innerHTML : un titre piégé reste hors du badge", () => {
    // fakeDocument() lève à toute écriture dans innerHTML / outerHTML.
    const { api, agents, run } = setup({ document: Object.assign(fakeDocument(), {}) });
    api.update(modelOf([feature(1, "in-progress", { retry: 1, title: "<img src=x onerror=alert(1)>" })]));
    run(1 / 60);
    assert.equal(agents.badges.get(1).element.textContent, "Retry 1");
  });
});

describe("branchement dans la scène et cycle de vie", () => {
  test("une couche créée après la première mise à jour reprend le modèle courant", () => {
    const container = fakeContainer();
    const api = createScene({ container, renderer: fakeRenderer(), window: fakeWindow() });
    api.update(modelOf([feature(1, "in-progress", { retry: 1 })], [agent("late", { phase: "running" })]));
    const agents = createAgents(api, { document: badgeDocument(), createComposer: null });
    assert.deepEqual([...agents.entities.keys()], ["late"]);
    assert.deepEqual([...agents.badges.keys()], [1]);
  });

  test("dispose retire la couche, les rappels et le rendu par compositeur, et libère les ressources", () => {
    const calls = [];
    const { api, agents, renderer, run } = setup({
      createComposer: (sceneApi) => {
        const composer = createBloomComposer(sceneApi);
        composer.render = () => calls.push(1);
        return composer;
      },
    });
    api.update(modelOf([feature(1, "in-progress", { retry: 1 })], [agent("a", { phase: "running" })]));
    run(0.1);
    const { group, composer } = agents;
    const entity = entityOf(agents, "a");
    let disposed = 0;
    entity.material.addEventListener("dispose", () => (disposed += 1));
    const rendersBefore = renderer.renders;
    const compositeCalls = calls.length;

    agents.dispose();

    assert.equal(api.scene.children.includes(group), false);
    assert.equal(agents.entities.size, 0);
    assert.equal(agents.badges.size, 0);
    assert.equal(disposed, 1);
    assert.equal(agents.composer, null);
    assert.ok(composer.renderTarget1);
    run(0.05);
    assert.equal(calls.length, compositeCalls, "le compositeur n'est plus appelé");
    assert.equal(renderer.renders - rendersBefore, 3, "le rendu direct est rétabli");
    api.update(modelOf([], [agent("z")]));
    assert.equal(agents.entities.size, 0, "plus de rappel onUpdate");
  });

  test("les couches sont libérées par leur appelant : scene.dispose() ne retire pas le groupe des agents", () => {
    const { api, agents } = setup();
    api.dispose();
    assert.ok(api.scene.children.includes(agents.group), "la scène ne touche pas à une couche qu'elle n'a pas créée");
    agents.dispose();
    assert.equal(api.scene.children.includes(agents.group), false);
  });

  test("setRender : la fonction de rétablissement ne casse pas un rendu posé depuis", () => {
    const { api, renderer, run } = setup();
    const calls = [];
    const restoreFirst = api.setRender(() => calls.push("first"));
    const restoreSecond = api.setRender(() => calls.push("second"));
    run(1 / 60);
    restoreFirst();
    run(1 / 60);
    assert.deepEqual(calls, ["second", "second"], "le premier rétablissement ne retire pas le second rendu");
    const rendersBefore = renderer.renders;
    restoreSecond();
    run(1 / 60);
    assert.equal(renderer.renders - rendersBefore, 1);
  });

  test("scene.size, scene.model et scene.reducedMotion décrivent l'état courant", () => {
    const { api, win } = setup();
    assert.deepEqual(api.size(), { width: 800, height: 600 });
    api.resize(1000, 500);
    assert.deepEqual(api.size(), { width: 1000, height: 500 });
    assert.equal(api.model(), null);
    const model = modelOf([]);
    api.update(model);
    assert.equal(api.model(), model);
    assert.equal(api.reducedMotion(), false);
    win.media.reduced = true;
    assert.equal(api.reducedMotion(), true);
    assert.deepEqual(win.media.queries, ["(prefers-reduced-motion: reduce)"]);
  });

  test("sans matchMedia, le mouvement n'est pas réduit", () => {
    const win = fakeWindow();
    delete win.matchMedia;
    const api = createScene({ container: fakeContainer(), renderer: fakeRenderer(), window: win });
    assert.equal(api.reducedMotion(), false);
  });
});

describe("main.js : le crochet onScene et le chargement des agents", () => {
  test("loadAgents branche les agents sur la scène (module chargé à la demande)", async () => {
    const api = createScene({ container: fakeContainer(), renderer: fakeRenderer(), window: fakeWindow() });
    const warnings = [];
    const win = { console: { warn: (m) => warnings.push(m) } };
    const before = new Set(api.scene.children);
    await loadAgents(api, win);
    const layers = api.scene.children.filter((o) => !before.has(o));
    assert.equal(layers.length, 1, "la couche des agents est ajoutée");
    assert.deepEqual(warnings, []);
    api.update(modelOf([], [agent("a", { phase: "running" })]));
    assert.equal(layers[0].children.length, 1, "l'agent est dessiné");
  });

  test("loadAgents n'interrompt pas la page si la couche échoue : l'erreur est signalée", async () => {
    const warnings = [];
    const win = { console: { warn: (m) => warnings.push(m) } };
    await loadAgents({}, win);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /agents lumineux indisponibles/);
  });

  test("boot n'appelle onScene que si la scène a pu être créée (ici : pas de WebGL, donc repli texte)", async () => {
    const elements = new Map(["connexion", "depot", "scene", "legende", "repli"].map((id) => [id, fakeElement("div", { dataset: {} })]));
    elements.get("repli").hidden = true;
    const doc = { getElementById: (id) => elements.get(id), createElement: (tag) => fakeElement(tag) };
    class FakeSource {
      readyState = 0;
      addEventListener() {}
      close() {}
    }
    const warnings = [];
    const win = {
      fetch: async () => ({ ok: true, json: async () => stateOf() }),
      EventSource: FakeSource,
      console: { warn: (m) => warnings.push(m) },
      addEventListener() {},
    };
    let called = 0;
    // boot() ne rend pas la connexion qu'il ouvre : on retient son minuteur périodique pour ne pas garder le processus en vie.
    const realSetInterval = globalThis.setInterval;
    const timers = [];
    globalThis.setInterval = (...args) => timers.push(realSetInterval(...args)) && timers.at(-1);
    try {
      await boot(doc, win, { onScene: () => (called += 1) });
    } finally {
      globalThis.setInterval = realSetInterval;
      timers.forEach((id) => clearInterval(id));
    }
    assert.equal(called, 0);
    assert.equal(elements.get("repli").hidden, false, "repli texte affiché");
    assert.ok(warnings.some((m) => m.includes("scène 3D indisponible")));
  });
});
