// Point de bascule de viz/public/js/main.js (`boot`) vers le repli texte : `?mode=texte`, et absence de WebGL (le vrai
// scene.js et le vrai `three` sont chargés ; seul le contexte WebGL ne peut pas être créé). Page, flux SSE et `fetch`
// sont factices. Le repli doit s'afficher sans exception et sans erreur dans la console.
import "./three-register.mjs";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { boot } from "../../viz/public/js/main.js";
import { fakePage, flatten } from "./dom-fakes.mjs";
import { agent, evt, feature, stateOf } from "./support.mjs";

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  close() {
    this.readyState = 2;
  }
  emit(type, data) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, data });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (condition) => {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  assert.ok(condition(), "condition jamais remplie");
};

const savedSetInterval = globalThis.setInterval;
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  globalThis.setInterval = savedSetInterval;
  if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
  else delete globalThis.document;
  FakeEventSource.instances = [];
});

// `boot` ne rend pas le minuteur de `connect` : on l'empêche de garder le processus de test en vie.
function unrefIntervals() {
  globalThis.setInterval = (fn, ms) => savedSetInterval(fn, ms).unref();
}

function fakeWindow({ search = "", state = stateOf() } = {}) {
  const console = { warnings: [], errors: [], warn: (m) => console.warnings.push(m), error: (m) => console.errors.push(m) };
  return {
    location: { search },
    console,
    EventSource: FakeEventSource,
    fetch: async () => ({ ok: true, status: 200, json: async () => state }),
  };
}

const texts = (el) => flatten(el).map((e) => e.textContent);

describe("?mode=texte force la vue de repli", () => {
  const state = stateOf({
    features: [feature(12, "in-progress", { title: "La scène", retry: 1 }), feature(13, "ready", { title: "Le repli" })],
    agents: [agent("a1", { type: "developpeur", mode: "IMPLEMENTATION", issue: 12, station: "dev" })],
  });

  test("la scène est masquée et le repli affiché, sans erreur ni avertissement dans la console", async () => {
    unrefIntervals();
    const page = fakePage();
    const win = fakeWindow({ search: "?mode=texte", state });
    await boot(page, win);
    assert.equal(page.elements.scene.hidden, true);
    assert.equal(page.elements.repli.hidden, false);
    assert.equal(page.elements.scene.children.length, 0, "aucun canvas n'a été ajouté");
    assert.deepEqual(win.console.warnings, [], "pas de repli « subi » : il est demandé");
    assert.deepEqual(win.console.errors, []);

    await until(() => page.elements.repli.children.length > 0);
    const shown = texts(page.elements.repli);
    assert.ok(shown.includes("#12 La scène"));
    assert.ok(shown.includes("retry 1"));
    assert.ok(shown.includes("#13 Le repli"));
    assert.ok(shown.includes("developpeur · IMPLEMENTATION · #12"));
    assert.equal(page.elements.depot.textContent, "o/r");
  });

  test("chaque message SSE met la liste à jour", async () => {
    unrefIntervals();
    const page = fakePage();
    await boot(page, fakeWindow({ search: "?mode=texte", state }));
    await until(() => page.elements.repli.children.length > 0);
    const source = FakeEventSource.instances[0];
    const station = (heading) => page.elements.repli.children.find((section) => section.children[0]?.textContent === heading);

    assert.ok(texts(station("Développement")).includes("#12 La scène"));
    assert.equal(texts(station("Vérification")).includes("#12 La scène"), false);

    const move = evt("feature.status", 5, { issue: 12, status: "in-review" });
    source.emit(move.event, move.data);
    assert.equal(texts(station("Développement")).includes("#12 La scène"), false, "la feature a quitté sa station");
    assert.ok(texts(station("Vérification")).includes("#12 La scène"));

    const spawn = evt("agent.requested", 6, { toolUseId: "t9", agentType: "claude-gepet-squad:verificateur", issue: 12 });
    source.emit(spawn.event, spawn.data);
    assert.ok(texts(station("Vérification")).includes("verificateur · #12"));
  });

  test("sans ce paramètre, le repli n'est pas forcé : la scène est tentée (et échoue ici, sans vrai WebGL)", async () => {
    unrefIntervals();
    const page = fakePage();
    const win = fakeWindow({ search: "?mode=3d", state });
    // Sous Node, la sonde réussit (faux contexte) puis la création du moteur de rendu échoue : le repli vient de cet échec.
    await boot(page, win);
    assert.equal(win.console.warnings.length, 1, "le repli vient de l'échec de la scène, pas de l'URL");
    assert.match(win.console.warnings[0], /scène 3D indisponible/);
  });
});

describe("absence de WebGL", () => {
  const state = stateOf({ features: [feature(3, "in-test", { title: "Sans WebGL", retry: 2 })] });

  // Ce que fait un navigateur sans WebGL : le canvas existe mais `getContext` renvoie `null`.
  const noContext = () => null;
  function threeWithoutWebGL() {
    // Le `document` global que `three` utilise pour créer son canvas : sans contexte, il lève « Error creating WebGL
    // context. » (et le journalise avec console.error).
    const canvas = () => ({ style: {}, addEventListener() {}, removeEventListener() {}, getContext: noContext });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElementNS: canvas, createElement: canvas } });
  }

  test("la sonde ne crée aucun contexte : repli texte, un seul avertissement, `three` n'est pas sollicité", async () => {
    unrefIntervals();
    threeWithoutWebGL();
    const threeErrors = [];
    const savedError = console.error;
    console.error = (...args) => threeErrors.push(args.join(" "));
    try {
      const page = fakePage({ getContext: noContext });
      const win = fakeWindow({ state });
      await assert.doesNotReject(boot(page, win));
      assert.equal(page.elements.scene.hidden, true);
      assert.equal(page.elements.repli.hidden, false);
      assert.deepEqual(win.console.warnings, ["[gepet-squad-viz] WebGL indisponible, repli texte"]);
      assert.deepEqual(win.console.errors, []);
      assert.deepEqual(threeErrors, [], "aucune erreur journalisée par three : il n'a pas été sollicité");
      await until(() => page.elements.repli.children.length > 0);
      assert.ok(texts(page.elements.repli).includes("#3 Sans WebGL"));
      assert.ok(texts(page.elements.repli).includes("retry 2"));
    } finally {
      console.error = savedError;
    }
  });

  test("la sonde passe mais le moteur de rendu échoue : filet de sécurité, repli texte sans exception", async () => {
    unrefIntervals();
    threeWithoutWebGL();
    const savedError = console.error;
    console.error = () => {}; // le message de three est attendu ici
    try {
      const page = fakePage(); // la sonde obtient un contexte
      const win = fakeWindow({ state });
      await assert.doesNotReject(boot(page, win));
      assert.equal(page.elements.scene.hidden, true);
      assert.equal(page.elements.repli.hidden, false);
      assert.equal(win.console.warnings.length, 1);
      assert.match(win.console.warnings[0], /WebGL context/);
      assert.deepEqual(win.console.errors, []);
      await until(() => page.elements.repli.children.length > 0);
      assert.ok(texts(page.elements.repli).includes("#3 Sans WebGL"));
    } finally {
      console.error = savedError;
    }
  });

  test("les messages SSE suivants mettent la liste à jour", async () => {
    unrefIntervals();
    const page = fakePage({ getContext: noContext });
    await boot(page, fakeWindow({ state }));
    await until(() => page.elements.repli.children.length > 0);
    const message = evt("feature.retry", 9, { issue: 3, retry: 3 });
    FakeEventSource.instances[0].emit(message.event, message.data);
    assert.ok(texts(page.elements.repli).includes("retry 3"));
    assert.equal(texts(page.elements.repli).includes("retry 2"), false);
  });
});
