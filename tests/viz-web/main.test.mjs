// Tests de viz/public/js/main.js (`connect`) avec un faux `EventSource` et un faux `fetch` : ordre de connexion,
// aucun événement perdu entre l'ouverture du flux et la lecture de `/state`, événements déjà repris par `/state`
// ignorés, indicateur de connexion, nouvelles tentatives, horloge. main.js n'importe pas `three` : il se charge sous Node.
import { test, describe } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";

import { connect } from "../../viz/public/js/main.js";
import { MAX_PENDING_MESSAGES } from "../../viz/public/js/sync.js";
import { agent, at, ev, feature, stateOf } from "./support.mjs";

// --- Faux navigateur --------------------------------------------------------------------------------------------------------

class FakeEventSource {
  static instances = [];
  static log = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
    FakeEventSource.log?.push(`EventSource ${url}`);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  // Ce que fait le navigateur : `e.type` est le nom de l'événement SSE, `e.data` la chaîne reçue.
  emit(type, data) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, data });
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  drop(readyState = 0) {
    this.readyState = readyState;
    this.emit("error");
  }
  evt(event) {
    this.emit("evt", JSON.stringify(event));
  }
}

// Faux `fetch` dont chaque réponse est résolue à la main.
function fakeFetch(log) {
  const calls = [];
  const fn = (url, options) => {
    log?.push(`fetch ${url}`);
    return new Promise((resolve, reject) => calls.push({ url, options, resolve, reject }));
  };
  fn.calls = calls;
  fn.respond = (state, index = calls.length - 1) => calls[index].resolve({ ok: true, status: 200, json: async () => state });
  fn.fail = (status, index = calls.length - 1) => calls[index].resolve({ ok: false, status, json: async () => ({}) });
  return fn;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  const log = [];
  FakeEventSource.instances = [];
  FakeEventSource.log = log;
  const fetch = fakeFetch(log);
  const updates = [];
  const statuses = [];
  const errors = [];
  const timers = [];
  const clearedTickers = [];
  const app = connect({
    fetch,
    EventSource: FakeEventSource,
    onUpdate: (model, transitions) => updates.push({ model, transitions }),
    onConnection: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    now: () => Date.parse(at(0)),
    // Les nouvelles tentatives sont immédiates ; l'horloge de `tick` est pilotée par le test.
    setTimeout: (fn) => queueMicrotask(fn),
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval: (id) => clearedTickers.push(id),
    ...options,
  });
  return { app, log, fetch, source: FakeEventSource.instances[0], updates, statuses, errors, timers, clearedTickers };
}

const stationOf = (model, number) => model.features.find((f) => f.number === number)?.station;

// --- Ordre de connexion -----------------------------------------------------------------------------------------------------

describe("ordre de connexion", () => {
  test("l'EventSource('/events') est ouvert AVANT la lecture de /state", () => {
    const { log, fetch } = setup();
    assert.deepEqual(log, ["EventSource /events", "fetch /state"]);
    assert.equal(FakeEventSource.instances.length, 1);
    assert.deepEqual(fetch.calls[0].options, { cache: "no-store" });
  });

  test("un préfixe d'URL (baseUrl) s'applique aux deux appels", () => {
    const { log } = setup({ baseUrl: "http://127.0.0.1:4242" });
    assert.deepEqual(log, ["EventSource http://127.0.0.1:4242/events", "fetch http://127.0.0.1:4242/state"]);
  });

  test("un événement reçu pendant la lecture de /state n'est pas perdu : il est appliqué dès que l'état est lu", async () => {
    const { app, source, fetch, updates } = setup();
    source.open();
    // La feature 1 passe en revue pendant que /state est en cours de lecture ; /state ne la montre pas encore.
    source.evt(ev("feature.status", 5, { issue: 1, status: "in-review" }));
    assert.equal(updates.length, 0, "rien n'est publié avant l'état initial");
    fetch.respond(stateOf({ updatedAt: at(0), features: [feature(1, "in-progress")] }));
    await app.ready;
    assert.equal(updates.length, 1);
    assert.equal(stationOf(app.getModel(), 1), "verification");
    assert.equal(app.getModel().features[0].status, "in-review");
  });

  test("plusieurs événements reçus pendant la lecture sont appliqués dans l'ordre d'arrivée", async () => {
    const { app, source, fetch } = setup();
    source.evt(ev("feature.status", 5, { issue: 1, status: "in-review" }));
    source.evt(ev("feature.status", 6, { issue: 1, status: "changes-requested" }));
    source.evt(ev("feature.status", 7, { issue: 2, status: "ready" }));
    fetch.respond(stateOf({ updatedAt: at(0), features: [feature(1, "in-progress")] }));
    await app.ready;
    const model = app.getModel();
    assert.equal(model.features.find((f) => f.number === 1).status, "changes-requested");
    assert.equal(stationOf(model, 2), "roadmap", "une feature inconnue de /state est créée par son événement");
  });

  test("un événement déjà reflété par /state est ignoré (il ne ramène pas la feature en arrière)", async () => {
    const { app, source, fetch } = setup();
    // /state, daté de 10:10, montre la feature 1 en revue. Un ancien événement (10:01, in-progress) arrive pendant la lecture.
    source.evt(ev("feature.status", 1, { issue: 1, status: "in-progress" }));
    fetch.respond(stateOf({ updatedAt: at(10), features: [feature(1, "in-review")] }));
    await app.ready;
    assert.equal(app.getModel().features[0].status, "in-review");
    assert.equal(stationOf(app.getModel(), 1), "verification");
  });

  test("un événement juste avant la date de /state (délai de suivi du journal) n'est pas écarté", async () => {
    const { app, source, fetch } = setup();
    const justBefore = new Date(Date.parse(at(10)) - 500).toISOString();
    source.evt({ ...ev("feature.status", 0, { issue: 1, status: "in-review" }), ts: justBefore });
    fetch.respond(stateOf({ updatedAt: at(10), features: [feature(1, "in-progress")] }));
    await app.ready;
    assert.equal(app.getModel().features[0].status, "in-review", "l'événement n'était pas encore dans /state");
  });

  test("après l'état initial, chaque message est appliqué immédiatement et publié avec ses transitions", async () => {
    const { app, source, fetch, updates } = setup();
    fetch.respond(stateOf({ updatedAt: at(0), features: [feature(1, "in-progress")] }));
    await app.ready;
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].transitions, []);

    source.evt(ev("feature.status", 3, { issue: 1, status: "in-review" }));
    assert.equal(updates.length, 2);
    assert.equal(stationOf(updates[1].model, 1), "verification");
    assert.deepEqual(updates[1].transitions, [{ kind: "feature-move", id: 1, from: "dev", to: "verification" }]);
  });

  test("un message sans effet ne publie rien ; un snapshot remplace le modèle", async () => {
    const { app, source, fetch, updates } = setup();
    fetch.respond(stateOf({ updatedAt: at(0), features: [feature(1, "in-progress")] }));
    await app.ready;
    source.emit("something-else", "{}");
    source.emit("evt", JSON.stringify({ v: 99, ts: at(1), type: "feature.status", issue: 1, status: "done" }));
    assert.equal(updates.length, 1, "nom d'événement inconnu, version de schéma future : rien à publier");
    source.emit("snapshot", JSON.stringify(stateOf({ updatedAt: at(1), features: [feature(7, "done")] })));
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[1].model.features.map((f) => f.number), [7]);
    assert.deepEqual(updates[1].transitions.map((t) => t.kind).sort(), ["feature-add", "feature-remove"]);
  });

  test("un message mal formé ajoute un avertissement au modèle sans lever d'exception", async () => {
    const { app, source, fetch } = setup();
    fetch.respond(stateOf({ updatedAt: at(0) }));
    await app.ready;
    source.emit("evt", "pas du json");
    assert.equal(app.getModel().warnings.at(-1).code, "EVENT_ERROR");
    source.emit("warning", JSON.stringify({ code: "SNAPSHOT_STALE", message: "vieux", at: at(1) }));
    assert.equal(app.getModel().warnings.at(-1).code, "SNAPSHOT_STALE");
  });

  test("un instantané reçu pendant la lecture remplace l'état lu, et les événements suivants s'y appliquent", async () => {
    const { app, source, fetch } = setup();
    source.emit("snapshot", JSON.stringify(stateOf({ updatedAt: at(5), features: [feature(1, "in-review")] })));
    source.evt(ev("feature.status", 4, { issue: 1, status: "in-progress" })); // déjà dans l'instantané : écarté
    source.evt(ev("feature.status", 6, { issue: 1, status: "in-test" }));
    fetch.respond(stateOf({ updatedAt: at(5), features: [feature(1, "in-progress")] }));
    await app.ready;
    assert.equal(app.getModel().features[0].status, "in-test");
  });

  test("les messages gardés pendant la lecture sont plafonnés (les plus récents restent)", async () => {
    const { app, source, fetch } = setup();
    for (let i = 1; i <= MAX_PENDING_MESSAGES + 50; i++) {
      source.evt({ ...ev("feature.status", 20, { issue: i, status: "ready" }) });
    }
    fetch.respond(stateOf({ updatedAt: at(0) }));
    await app.ready;
    const numbers = app.getModel().features.map((f) => f.number);
    assert.equal(numbers.length, MAX_PENDING_MESSAGES);
    assert.equal(numbers.at(-1), MAX_PENDING_MESSAGES + 50);
    assert.equal(numbers[0], 51);
  });
});

// --- Indicateur de connexion -------------------------------------------------------------------------------------------------

describe("indicateur de connexion", () => {
  test("connexion, connecté, reconnexion, reconnecté, déconnecté", () => {
    const { source, statuses } = setup();
    assert.deepEqual(statuses.map((s) => s.text), ["connexion…"]);
    source.open();
    assert.equal(statuses.at(-1).text, "connecté");
    source.drop(0);
    assert.deepEqual(statuses.at(-1), { state: "reconnecting", text: "reconnexion…" });
    source.open();
    assert.equal(statuses.at(-1).text, "connecté");
    source.drop(2);
    assert.deepEqual(statuses.at(-1), { state: "closed", text: "déconnecté" });
  });

  test("une erreur avant la première ouverture reste « connexion », pas « reconnexion »", () => {
    const { source, statuses } = setup();
    source.drop(0);
    assert.equal(statuses.at(-1).text, "connexion…");
  });

  test("après une reconnexion, les messages du flux (rejeu, instantané) sont appliqués", async () => {
    const { app, source, fetch } = setup();
    fetch.respond(stateOf({ updatedAt: at(0), features: [feature(1, "in-progress")] }));
    await app.ready;
    source.open();
    source.drop(0);
    source.open();
    source.emit("snapshot", JSON.stringify(stateOf({ updatedAt: at(9), features: [feature(1, "done")] })));
    assert.equal(app.getModel().features[0].status, "done");
  });
});

// --- /state indisponible ----------------------------------------------------------------------------------------------------

describe("lecture de /state en échec", () => {
  test("une réponse HTTP en erreur est signalée puis relue ; les événements reçus entre-temps sont appliqués ensuite", async () => {
    const { app, source, fetch, errors, updates } = setup();
    source.evt(ev("feature.status", 5, { issue: 1, status: "in-review" }));
    fetch.fail(503, 0);
    await tick();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /HTTP 503/);
    assert.equal(fetch.calls.length, 2, "nouvelle tentative");
    assert.equal(updates.length, 0);
    fetch.respond(stateOf({ updatedAt: at(0), features: [feature(1, "in-progress")] }), 1);
    await app.ready;
    assert.equal(app.getModel().features[0].status, "in-review");
  });

  test("une erreur réseau ou un JSON invalide est signalé et relu", async () => {
    const { app, fetch, errors } = setup();
    fetch.calls[0].reject(new Error("réseau coupé"));
    await tick();
    fetch.calls[1].resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("JSON invalide"); } });
    await tick();
    assert.deepEqual(errors.map((e) => e.message), ["réseau coupé", "JSON invalide"]);
    fetch.respond(stateOf({ updatedAt: at(0) }), 2);
    await app.ready;
    assert.ok(app.getModel());
  });

  test("close() pendant la lecture : plus de nouvelle tentative, flux fermé", async () => {
    const { app, fetch, source } = setup();
    app.close();
    assert.equal(source.closed, true);
    fetch.calls[0].reject(new Error("coupé"));
    await app.ready;
    assert.equal(fetch.calls.length, 1);
    assert.equal(app.getModel(), null);
  });

  test("close() avant la réponse de /state : l'état tardif n'est pas appliqué", async () => {
    const { app, fetch, updates } = setup();
    app.close();
    fetch.respond(stateOf({ updatedAt: at(0), features: [feature(1, "ready")] }));
    await app.ready;
    assert.equal(updates.length, 0);
  });
});

// --- Horloge ---------------------------------------------------------------------------------------------------------------

describe("horloge (tick)", () => {
  test("un agent terminé depuis plus de 10 min est retiré au passage du minuteur et la mise à jour est publiée", async () => {
    const finished = agent("a1", { phase: "finished", finishedAt: at(-30), updatedAt: at(-30) });
    const { app, fetch, timers, updates } = setup({ now: () => Date.parse(at(0)) });
    fetch.respond(stateOf({ updatedAt: at(0), agents: [finished] }));
    await app.ready;
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 30000);
    assert.equal(app.getModel().agents.length, 1);
    timers[0].fn();
    assert.equal(app.getModel().agents.length, 0);
    assert.deepEqual(updates.at(-1).transitions, [{ kind: "agent-remove", id: "a1", from: "dev", to: null }]);
  });

  test("le minuteur ne publie rien quand rien ne change, ni avant l'état initial", async () => {
    const { app, fetch, timers, updates } = setup();
    timers[0].fn();
    assert.equal(updates.length, 0);
    fetch.respond(stateOf({ updatedAt: at(0), agents: [agent("a1")] }));
    await app.ready;
    timers[0].fn();
    assert.equal(updates.length, 1);
  });

  test("close() arrête le minuteur", () => {
    const { app, clearedTickers } = setup();
    app.close();
    assert.deepEqual(clearedTickers, [1]);
    app.close();
    assert.deepEqual(clearedTickers, [1], "un second close() ne l'arrête pas deux fois");
  });
});

describe("bonhommes", () => {
  const source = fs.readFileSync(new URL("../../viz/public/js/main.js", import.meta.url), "utf8");

  test("main.js charge characters.js : plus de sphères ni de bloom", () => {
    assert.match(source, /import\("\.\/characters\.js"\)/);
    assert.match(source, /createCharacters\(scene/);
    assert.doesNotMatch(source, /agents\.js|createAgents|loadAgents/);
  });

  test("le repli texte et ?mode=texte restent branchés sur forcesFallback et webglAvailable", () => {
    assert.match(source, /forcesFallback\(win\.location\?\.search\)/);
    assert.match(source, /webglAvailable\(doc\)/);
    assert.match(source, /if \(textOnly\) return;/);
  });
});
