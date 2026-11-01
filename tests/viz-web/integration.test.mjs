// Intégration : le vrai serveur (`node viz/server.cjs`, dossier public par défaut = viz/public, faux `gh`, journal d'un
// repo temporaire) face au vrai `connect()` de main.js, avec Node `fetch` et un `EventSource` réel au-dessus de node:http.
// Vérifie : la page est servie avec une CSP qui couvre l'importmap, et qu'une ligne `feature.status` ajoutée au journal
// déplace la feature de station en moins de 3 s, sans rechargement.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

import { boot, connect } from "../../viz/public/js/main.js";
import { layoutFeatures } from "../../viz/public/js/layout.js";
import { fakePage, flatten } from "./dom-fakes.mjs";
import { INDEX_HTML, PUBLIC_DIR } from "./importmap.mjs";

const require = createRequire(import.meta.url);
const { createTempRepo, gitCommonDir, installFakeGh, createSseParser } = require("../helpers/index.cjs");
const { ghFixtureRoutes, startVizProcess } = require("../helpers/viz-process.cjs");
const { importmapHash } = require("../../viz/lib/http.cjs");

const SESSION = "5f3c1a9e-7b2d-4c6e-9a41-0d8e2b7f6c13";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

// `EventSource` minimal au-dessus de node:http, avec la même interface que celle du navigateur utilisée par main.js :
// addEventListener, readyState (0 connexion, 1 ouvert, 2 fermé), close(), et des événements { type, data }.
function nodeEventSource() {
  return class NodeEventSource {
    constructor(url) {
      this.readyState = 0;
      this.listeners = new Map();
      const parser = createSseParser();
      this.request = http.get(url, { headers: { Accept: "text/event-stream" } }, (res) => {
        this.readyState = 1;
        this.dispatch("open", {});
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          for (const message of parser.feed(chunk)) this.dispatch(message.event, { data: message.data });
        });
        res.on("close", () => {
          if (this.readyState !== 2) {
            this.readyState = 0;
            this.dispatch("error", {});
          }
        });
      });
      this.request.on("error", () => {
        this.readyState = 2;
        this.dispatch("error", {});
      });
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    dispatch(type, fields) {
      for (const fn of this.listeners.get(type) ?? []) fn({ type, ...fields });
    }
    close() {
      this.readyState = 2;
      this.request.destroy();
    }
  };
}

async function startFixtureServer() {
  const repo = createTempRepo();
  cleanups.push(repo.cleanup);
  fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), JSON.stringify({ version: 1, repo: "o/r" }));
  const journalDir = path.join(gitCommonDir(repo.dir), "gepet-squad");
  fs.mkdirSync(journalDir, { recursive: true });
  const journal = path.join(journalDir, "events.jsonl");
  fs.writeFileSync(journal, "");

  const fake = installFakeGh({ routes: ghFixtureRoutes() });
  cleanups.push(fake.cleanup);
  // Dossier public par défaut (`publicArg: ""`) : la vraie page, viz/public.
  const proc = startVizProcess({ project: repo.dir, fake, publicArg: "" });
  cleanups.push(() => proc.child.kill("SIGKILL"));
  const port = await proc.ready;
  return { repo, journal, port, baseUrl: `http://127.0.0.1:${port}` };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, timeoutMs, label) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`délai de ${timeoutMs} ms dépassé : ${label}`);
    await sleep(20);
  }
  return Date.now() - start;
}

describe("la page servie par le vrai serveur", () => {
  test("index.html est servie avec une CSP qui autorise exactement son importmap, et ses fichiers sont tous servis", async () => {
    const { baseUrl } = await startFixtureServer();
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    const html = await response.text();
    assert.equal(html, fs.readFileSync(INDEX_HTML, "utf8"));
    const csp = response.headers.get("content-security-policy");
    assert.ok(csp.includes(`'${importmapHash(html)}'`), csp);
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.match(csp, /style-src 'self'(;|$)/);

    const files = [
      "css/app.css",
      "css/fallback.css",
      "js/main.js",
      ...fs.readdirSync(path.join(PUBLIC_DIR, "js")).map((f) => `js/${f}`),
      "vendor/three/build/three.module.js",
      "vendor/three/build/three.core.js",
      "vendor/three/addons/controls/OrbitControls.js",
      "vendor/three/addons/renderers/CSS2DRenderer.js",
    ];
    for (const file of files) {
      const served = await fetch(`${baseUrl}/${file}`);
      assert.equal(served.status, 200, file);
      assert.equal(await served.text(), fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8"), file);
    }
  });
});

describe("main.js face au vrai serveur (intégration)", () => {
  test("une ligne feature.status ajoutée au journal déplace la feature de station en moins de 3 s, sans rechargement", async () => {
    const server = await startFixtureServer();
    const updates = [];
    const statuses = [];
    const app = connect({
      fetch,
      EventSource: nodeEventSource(),
      baseUrl: server.baseUrl,
      onUpdate: (model, transitions) => updates.push({ model, transitions }),
      onConnection: (status) => statuses.push(status.text),
    });
    cleanups.push(() => app.close());

    await app.ready;
    await until(() => statuses.includes("connecté"), 5000, "indicateur « connecté »");
    const initial = app.getModel();
    assert.equal(initial.repo, "o/r");
    // Une feature qui n'est ni terminée ni bloquée : on la fait avancer vers la revue.
    const target = initial.features.find((f) => !["in-review", "done", "blocked"].includes(f.status));
    assert.ok(target, `aucune feature utilisable dans ${JSON.stringify(initial.features.map((f) => [f.number, f.status]))}`);
    const before = layoutFeatures(initial).get(target.number);
    assert.ok(before, "la feature a une place dans la scène");

    const written = Date.now();
    fs.appendFileSync(
      server.journal,
      JSON.stringify({ v: 1, ts: new Date().toISOString(), src: "hook", type: "feature.status", sessionId: SESSION, issue: target.number, status: "in-review" }) + "\n",
    );
    const elapsed = await until(
      () => app.getModel().features.find((f) => f.number === target.number)?.status === "in-review",
      3000,
      "la feature passe en revue",
    );
    assert.ok(Date.now() - written < 3000, `${Date.now() - written} ms`);
    assert.ok(elapsed < 3000);

    const model = app.getModel();
    const after = layoutFeatures(model).get(target.number);
    assert.equal(after.station, "verification");
    assert.notEqual(after.station, before.station);
    assert.ok(after.x !== before.x, "la position 3D change");
    const last = updates.at(-1);
    assert.deepEqual(
      last.transitions.filter((t) => t.id === target.number),
      [{ kind: "feature-move", id: target.number, from: before.station, to: "verification" }],
    );
  });

  test("un événement ajouté au journal pendant la lecture de /state n'est pas perdu", async () => {
    const server = await startFixtureServer();
    // /state est ralenti : l'événement est écrit pendant que la réponse est en attente, après l'ouverture du flux.
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let stateRequested = false;
    const slowFetch = async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith("/state")) {
        stateRequested = true;
        const body = await response.text();
        await gate;
        return { ok: response.ok, status: response.status, json: async () => JSON.parse(body) };
      }
      return response;
    };
    const app = connect({
      fetch: slowFetch,
      EventSource: nodeEventSource(),
      baseUrl: server.baseUrl,
    });
    cleanups.push(() => app.close());
    await until(() => stateRequested, 5000, "/state lu par le client");

    // /state (déjà lu par le client) ne montre pas cette feature ; le serveur la reçoit du journal maintenant.
    fs.appendFileSync(
      server.journal,
      JSON.stringify({ v: 1, ts: new Date().toISOString(), src: "hook", type: "feature.status", sessionId: SESSION, issue: 9001, status: "in-test" }) + "\n",
    );
    await sleep(1500); // le serveur suit le journal toutes les 500 ms, puis diffuse sur le flux déjà ouvert
    assert.equal(app.getModel(), null, "rien n'est publié avant la fin de la lecture de /state");
    release();
    await app.ready;
    const found = app.getModel().features.find((f) => f.number === 9001);
    assert.ok(found, "l'événement reçu pendant la lecture est appliqué");
    assert.equal(found.status, "in-test");
    assert.equal(found.station, "test");
  });
});

describe("repli texte face au vrai serveur (intégration)", () => {
  test("boot() en ?mode=texte : la liste suit une ligne ajoutée au journal, sans rechargement", async () => {
    const server = await startFixtureServer();
    // `boot` ne rend pas le minuteur de `connect` : on l'empêche de garder le processus de test en vie.
    const savedSetInterval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms) => savedSetInterval(fn, ms).unref();
    cleanups.push(() => {
      globalThis.setInterval = savedSetInterval;
    });
    const NodeEventSource = nodeEventSource();
    const sources = [];
    class PageEventSource extends NodeEventSource {
      constructor(url) {
        super(server.baseUrl + url);
        sources.push(this);
      }
    }
    cleanups.push(() => sources.forEach((source) => source.close()));
    const warnings = [];
    const win = {
      location: { search: "?mode=texte" },
      console: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
      EventSource: PageEventSource,
      fetch: (url, options) => fetch(server.baseUrl + url, options),
    };
    const page = fakePage();
    await boot(page, win);
    assert.equal(page.elements.scene.hidden, true);
    assert.equal(page.elements.repli.hidden, false);

    const repli = page.elements.repli;
    const section = (heading) => repli.children.find((el) => el.children[0]?.textContent === heading);
    const rowsOf = (heading) => flatten(section(heading) ?? { children: [] }).filter((el) => el.className === "repli-titre").map((el) => el.textContent);
    await until(() => repli.children.length > 0, 5000, "liste affichée");
    assert.equal(page.elements.depot.textContent, "o/r");

    // Une feature qui n'est ni terminée ni bloquée : on la fait avancer vers la revue.
    const all = ["Cadrage", "Roadmap", "Développement", "Vérification", "Test", "Merge", "Release"].flatMap((heading) => rowsOf(heading).map((text) => ({ heading, text })));
    assert.ok(all.length > 0, "la liste montre les features du dépôt");
    const target = all.find(({ heading }) => ["Roadmap", "Développement", "Test"].includes(heading));
    assert.ok(target, JSON.stringify(all));
    const number = Number(/^#(\d+)/.exec(target.text)[1]);
    assert.ok(!rowsOf("Vérification").includes(target.text));

    fs.appendFileSync(
      server.journal,
      JSON.stringify({ v: 1, ts: new Date().toISOString(), src: "hook", type: "feature.status", sessionId: SESSION, issue: number, status: "in-review" }) + "\n",
    );
    await until(() => rowsOf("Vérification").includes(target.text), 3000, `#${number} apparaît dans « Vérification »`);
    assert.ok(!rowsOf(target.heading).includes(target.text), "et a quitté sa station précédente");
    assert.deepEqual(warnings, []);
  });
});
