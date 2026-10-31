// Tests d'intégration de GET /events : le serveur est démarré dans le processus de test (startServer), sur un port
// éphémère, avec un repo git temporaire, un journal temporaire et le faux `gh`. Le client est celui de tests/helpers.
// Les durées (recalage, battement, suivi) sont réduites par les options de startServer ; le test « moins de 2 s »
// garde la période du suivi par défaut (500 ms).
//
// Le faux gh : un dossier unique pour tout le fichier, dont on change les réponses (responses.json) pour faire
// échouer ou réussir le recalage. Sous Windows, gh est un .cmd : le module gh-preload redirige execFile("gh") vers
// `node fake-gh.cjs` (le module est chargé une fois, avant les tests, comme pour server.test.cjs).
const { test, describe, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const { createTempRepo, gitCommonDir, installFakeGh, openSse } = require("../helpers/index.cjs");

const GH_FIXTURES = path.join(__dirname, "..", "fixtures", "gh-json");
const PUBLIC_DIR = path.join(__dirname, "..", "fixtures", "public");
const SESSION = "5f3c1a9e-7b2d-4c6e-9a41-0d8e2b7f6c13";

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(GH_FIXTURES, name), "utf8"));
function okRoutes() {
  return [
    { match: ["api", "-X", "GET", "repos/o/r/milestones"], json: fixture("milestones.json") },
    { match: ["issue", "list", "--repo", "o/r"], json: fixture("issues.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "open"], json: fixture("pulls-open.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "develop"], json: fixture("pulls-merged-develop.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "main"], json: fixture("pulls-merged-main.json") },
  ];
}

// --- faux gh partagé ------------------------------------------------------------------------------------------

let fakeGh;
const savedEnv = {};
let startServer;

before(() => {
  fakeGh = installFakeGh({ routes: okRoutes() });
  const pathKey = Object.keys(fakeGh.env()).find((key) => key.toUpperCase() === "PATH");
  for (const key of [pathKey, "GEPET_TEST_FAKE_GH_SCRIPT"]) savedEnv[key] = process.env[key];
  process.env[pathKey] = fakeGh.env()[pathKey];
  if (process.platform === "win32") {
    process.env.GEPET_TEST_FAKE_GH_SCRIPT = path.join(fakeGh.dir, "fake-gh.cjs");
    require("../helpers/gh-preload.cjs");
  }
  ({ startServer } = require("../../viz/server.cjs"));
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fakeGh.cleanup();
});

const setGh = (routes) => fs.writeFileSync(path.join(fakeGh.dir, "responses.json"), JSON.stringify({ routes }));

// --- aides ------------------------------------------------------------------------------------------------------

const cleanups = [];
afterEach(async () => {
  setGh(okRoutes());
  while (cleanups.length > 0) await cleanups.pop()();
});

let counter = 0;
/** Événement v1 valide, daté de maintenant (le réducteur écarte les agents trop anciens). */
function ev(extra = {}) {
  counter += 1;
  return {
    v: 1, ts: new Date().toISOString(), src: "hook", type: "agent.started", sessionId: SESSION,
    agentId: `dev${counter}`, agentType: "claude-gepet-squad:developpeur", ...extra,
  };
}
const line = (event) => (typeof event === "string" ? event : JSON.stringify(event)) + "\n";

/** Supprime un dossier temporaire ; attend (boucle d'événements libre) la fin d'un éventuel `gh` qui l'occupe. */
async function removeWithRetries(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 50 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Repo avec .gepet-squad.json ; `journal` : lignes déjà présentes dans events.jsonl (aucune par défaut). */
function squadRepo({ journal = [] } = {}) {
  const repo = createTempRepo();
  // Un `gh` lancé par un recalage en cours a ce dossier pour dossier courant : sous Windows il le verrouille jusqu'à
  // sa fin, d'où les nouvelles tentatives.
  cleanups.push(() => removeWithRetries(path.dirname(repo.dir)));
  fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), JSON.stringify({ version: 1, repo: "o/r" }));
  const journalDir = path.join(gitCommonDir(repo.dir), "gepet-squad");
  fs.mkdirSync(journalDir, { recursive: true });
  const events = path.join(journalDir, "events.jsonl");
  const rotated = path.join(journalDir, "events.1.jsonl");
  if (journal.length > 0) fs.writeFileSync(events, journal.map(line).join(""));
  return { dir: repo.dir, events, rotated, append: (event) => fs.appendFileSync(events, line(event)) };
}

async function runServer(options = {}) {
  const { repo: given, ...serverOptions } = options;
  const repo = given || squadRepo();
  const running = await startServer({ project: repo.dir, port: 0, publicDir: PUBLIC_DIR, pollIntervalMs: 40, ...serverOptions });
  cleanups.push(() => running.close());
  const url = `http://127.0.0.1:${running.port}`;
  return { repo, running, url, state: () => getJson(`${url}/state`) };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      })
      .on("error", reject);
  });
}

/** Réponse brute (statut + en-têtes) pour une requête quelconque, sans suivre un flux. */
function rawRequest(port, { method = "GET", target = "/events", host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method, agent: false, headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function connect(url, headers) {
  const client = await openSse(`${url}/events`, { headers });
  cleanups.push(() => client.close());
  return client;
}

const names = (events) => events.map((e) => e.event);
const evtEvents = (events) => events.filter((e) => e.event === "evt");
async function eventually(check, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------------------------------------------

describe("GET /events : réponse", () => {
  test("text/event-stream, CSP et nosniff, jamais de CORS ; Cache-Control: no-store", async () => {
    const { url } = await runServer();
    const client = await connect(url);
    assert.equal(client.status, 200);
    assert.match(client.headers["content-type"], /^text\/event-stream/);
    assert.equal(client.headers["cache-control"], "no-store");
    assert.equal(client.headers["x-content-type-options"], "nosniff");
    assert.match(client.headers["content-security-policy"], /default-src 'self'/);
    assert.ok(!Object.keys(client.headers).some((h) => h.startsWith("access-control-")));
  });

  test("seul GET est accepté (HEAD, POST : 405) et le Host est contrôlé (421)", async () => {
    const { running } = await runServer();
    for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
      const res = await rawRequest(running.port, { method });
      assert.equal(res.status, 405, method);
    }
    assert.equal((await rawRequest(running.port, { host: "evil.example" })).status, 421);
    assert.equal((await rawRequest(running.port, { host: `localhost:${running.port + 1}` })).status, 421);
  });
});

describe("GET /events : événements du journal", () => {
  test("une ligne ajoutée au journal arrive en moins de 2 s (suivi par défaut, 500 ms), au format du contrat", async () => {
    const repo = squadRepo({ journal: [ev(), ev()] });
    const { url } = await runServer({ repo, pollIntervalMs: undefined });
    const client = await connect(url);

    const event = ev({ type: "agent.requested", toolUseId: "toolu_new", agentType: "claude-gepet-squad:verificateur", issue: 8, pr: 31 });
    const t0 = Date.now();
    repo.append(event);
    await client.waitFor((events) => evtEvents(events).length >= 1, 2000);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `reçu en ${elapsed} ms`);

    const [received] = evtEvents(client.events);
    assert.equal(received.event, "evt");
    assert.deepEqual(JSON.parse(received.data), event, "data est la chaîne JSON de l'événement v1");
    assert.match(received.id, /^\d+:\d+$/);
    assert.equal(Number(received.id.split(":")[1]), fs.statSync(repo.events).size, "l'offset est la fin de la ligne");
    assert.equal(client.events.length, 1, "ni rejeu du journal existant ni instantané à la première connexion");
  });

  test("les événements arrivent dans l'ordre, avec des offsets croissants dans une même génération", async () => {
    const repo = squadRepo();
    const { url } = await runServer({ repo });
    const client = await connect(url);
    const sent = [ev(), ev(), ev()];
    for (const event of sent) repo.append(event);
    await client.waitFor((events) => evtEvents(events).length === 3);
    const received = evtEvents(client.events);
    assert.deepEqual(received.map((e) => JSON.parse(e.data)), sent);
    const offsets = received.map((e) => Number(e.id.split(":")[1]));
    assert.deepEqual([...offsets].sort((a, b) => a - b), offsets);
    assert.equal(new Set(received.map((e) => e.id.split(":")[0])).size, 1);
  });

  test("plusieurs clients reçoivent le même flux", async () => {
    const repo = squadRepo();
    const { url } = await runServer({ repo });
    const [a, b] = [await connect(url), await connect(url)];
    repo.append(ev());
    await Promise.all([a, b].map((c) => c.waitFor((events) => evtEvents(events).length === 1)));
    assert.equal(evtEvents(a.events)[0].id, evtEvents(b.events)[0].id);
  });

  test("le journal absent au démarrage : le flux démarre à la création du fichier", async () => {
    const repo = squadRepo();
    assert.ok(!fs.existsSync(repo.events));
    const { url } = await runServer({ repo });
    const client = await connect(url);
    repo.append(ev());
    await client.waitFor((events) => evtEvents(events).length === 1);
  });

  test("lignes illisibles ou hors schéma : ignorées, les suivantes arrivent ; /state ne change pas", async () => {
    const repo = squadRepo();
    const { url, state } = await runServer({ repo });
    const client = await connect(url);
    const good = ev({ agentId: "bonne" });
    fs.appendFileSync(repo.events, "pas du json\n" + line({ ...ev(), inconnu: 1 }) + line({ ...ev(), type: "agent.dance" }) + "\n");
    repo.append(good);
    await client.waitFor((events) => evtEvents(events).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(evtEvents(client.events).map((e) => JSON.parse(e.data)), [good]);
    const ids = (await state()).agents.map((a) => a.agentId);
    assert.deepEqual(ids, ["bonne"]);
  });

  test("ligne partielle : rien n'est envoyé avant le \\n, puis l'événement arrive entier", async () => {
    const repo = squadRepo();
    const { url } = await runServer({ repo });
    const client = await connect(url);
    const event = ev({ agentId: "morceau" });
    const text = JSON.stringify(event);
    fs.appendFileSync(repo.events, text.slice(0, 40));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(client.events.length, 0);
    fs.appendFileSync(repo.events, text.slice(40) + "\n");
    await client.waitFor((events) => evtEvents(events).length === 1);
    assert.deepEqual(JSON.parse(client.events[0].data), event);
  });

  test("l'événement poussé est aussi dans /state (même vue pour un client qui se connecte plus tard)", async () => {
    const repo = squadRepo();
    const { url, state } = await runServer({ repo });
    assert.deepEqual((await state()).agents, []);
    const client = await connect(url);
    repo.append(ev({ agentId: "nouveau" }));
    await client.waitFor((events) => evtEvents(events).length === 1);
    assert.deepEqual((await state()).agents.map((a) => a.agentId), ["nouveau"]);
  });
});

describe("GET /events : reprise par Last-Event-ID", () => {
  test("même génération : les événements postérieurs à l'offset, dans l'ordre, sans instantané", async () => {
    const repo = squadRepo();
    const { url } = await runServer({ repo });
    const first = await connect(url);
    const [a, b, c, d] = [ev({ agentId: "a" }), ev({ agentId: "b" }), ev({ agentId: "c" }), ev({ agentId: "d" })];
    repo.append(a);
    await first.waitFor((events) => evtEvents(events).length === 1);
    const lastSeen = evtEvents(first.events)[0].id;
    first.close();

    // b, c, d arrivent pendant que le client est déconnecté
    repo.append(b);
    repo.append(c);
    await eventually(async () => (await getJson(`${url}/state`)).agents.length === 3, "le serveur n'a pas lu b et c");
    repo.append(d);

    const second = await connect(url, { "Last-Event-ID": lastSeen });
    await second.waitFor((events) => evtEvents(events).length === 3);
    assert.deepEqual(evtEvents(second.events).map((e) => JSON.parse(e.data).agentId), ["b", "c", "d"]);
    assert.ok(!names(second.events).includes("snapshot"), "reprise possible : pas d'instantané");
    assert.equal(evtEvents(second.events)[0].id.split(":")[0], lastSeen.split(":")[0]);
  });

  test("à jour : rien à rejouer, puis le flux continue", async () => {
    const repo = squadRepo();
    const { url } = await runServer({ repo });
    const first = await connect(url);
    repo.append(ev());
    await first.waitFor((events) => evtEvents(events).length === 1);
    const lastSeen = evtEvents(first.events)[0].id;

    const second = await connect(url, { "Last-Event-ID": lastSeen });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(second.events, []);
    const next = ev({ agentId: "suivant" });
    repo.append(next);
    await second.waitFor((events) => evtEvents(events).length === 1);
    assert.deepEqual(JSON.parse(second.events[0].data), next);
  });

  test("Last-Event-ID d'une autre génération (périmée) : un instantané complet, puis le flux", async () => {
    const repo = squadRepo({ journal: [ev({ agentId: "ancien" })] });
    const { url } = await runServer({ repo });
    const client = await connect(url, { "Last-Event-ID": "1:0" });
    await client.waitFor((events) => events.length >= 1);
    assert.equal(client.events[0].event, "snapshot", "l'instantané passe avant tout autre message");
    const snapshot = JSON.parse(client.events[0].data);
    assert.equal(snapshot.repo, "o/r");
    for (const key of ["milestones", "features", "agents", "releases", "warnings"]) assert.ok(Array.isArray(snapshot[key]), key);
    assert.deepEqual(snapshot.agents.map((a) => a.agentId), ["ancien"], "l'instantané contient l'état du journal");
    assert.match(client.events[0].id, /^\d+:\d+$/, "l'instantané porte la position à laquelle il correspond");

    const next = ev({ agentId: "apres" });
    repo.append(next);
    await client.waitFor((events) => evtEvents(events).length === 1);
    assert.deepEqual(names(client.events), ["snapshot", "evt"]);
    assert.deepEqual(JSON.parse(client.events[1].data), next);
  });

  test("Last-Event-ID inconnu, mal formé ou au-delà de la fin du fichier : instantané", async () => {
    const repo = squadRepo({ journal: [ev()] });
    const { url } = await runServer({ repo });
    const generation = (await getSnapshotId(url)).split(":")[0];
    for (const id of ["abc", "12", "::", `${generation}:99999999`]) {
      const client = await connect(url, { "Last-Event-ID": id });
      await client.waitFor((events) => events.length >= 1);
      assert.equal(client.events[0].event, "snapshot", id);
      client.close();
    }
  });

  test("après l'instantané, la reconnexion avec son id reprend sans le rejouer", async () => {
    const repo = squadRepo();
    const { url } = await runServer({ repo });
    const first = await connect(url, { "Last-Event-ID": "1:0" });
    await first.waitFor((events) => events.length >= 1);
    const snapshotId = first.events[0].id;
    first.close();
    repo.append(ev({ agentId: "x" }));
    await eventually(async () => (await getJson(`${url}/state`)).agents.length === 1, "événement non lu");
    const second = await connect(url, { "Last-Event-ID": snapshotId });
    await second.waitFor((events) => events.length >= 1);
    assert.deepEqual(names(second.events), ["evt"]);
    assert.equal(JSON.parse(second.events[0].data).agentId, "x");
  });

  test("un redémarrage du serveur change de génération : l'ancien id reçoit un instantané", async () => {
    const repo = squadRepo();
    const first = await runServer({ repo, generation: 1000 });
    const client = await connect(first.url);
    repo.append(ev());
    await client.waitFor((events) => evtEvents(events).length === 1);
    const lastSeen = evtEvents(client.events)[0].id;
    assert.equal(lastSeen.split(":")[0], "1000");
    client.close();
    await first.running.close();

    const second = await runServer({ repo, generation: 2000 });
    const again = await connect(second.url, { "Last-Event-ID": lastSeen });
    await again.waitFor((events) => events.length >= 1);
    assert.equal(again.events[0].event, "snapshot");
  });
});

/** Position courante du serveur, lue par un client sans Last-Event-ID : l'id de l'instantané d'une reprise forcée. */
async function getSnapshotId(url) {
  const client = await connect(url, { "Last-Event-ID": "0:0" });
  await client.waitFor((events) => events.length >= 1);
  const id = client.events[0].id;
  client.close();
  return id;
}

describe("GET /events : rotation du journal", () => {
  test("events.jsonl recréé plus petit : reprise à 0, génération suivante ; l'ancien id reçoit un instantané", async () => {
    const repo = squadRepo({ journal: [ev({ agentId: "r1" }), ev({ agentId: "r2" }), ev({ agentId: "r3" })] });
    const { url, state } = await runServer({ repo, generation: 50 });
    const client = await connect(url);

    const before = ev({ agentId: "avant" });
    repo.append(before);
    await client.waitFor((events) => evtEvents(events).length === 1);
    const oldId = evtEvents(client.events)[0].id;
    assert.match(oldId, /^50:/);
    const oldSize = fs.statSync(repo.events).size;

    fs.renameSync(repo.events, repo.rotated); // comme le collecteur (hooks/lib/journal.cjs)
    const after = ev({ agentId: "apres" });
    repo.append(after);
    assert.ok(fs.statSync(repo.events).size < oldSize);

    await client.waitFor((events) => evtEvents(events).length === 2);
    const received = evtEvents(client.events)[1];
    assert.equal(JSON.parse(received.data).agentId, "apres");
    assert.equal(received.id, `51:${fs.statSync(repo.events).size}`, "génération + 1, offset reparti de 0");

    // Les événements de l'ancien fichier restent dans l'état.
    assert.deepEqual((await state()).agents.map((a) => a.agentId).sort(), ["apres", "avant", "r1", "r2", "r3"]);

    const stale = await connect(url, { "Last-Event-ID": oldId });
    await stale.waitFor((events) => events.length >= 1);
    assert.equal(stale.events[0].event, "snapshot", "l'offset de l'ancienne génération n'a plus de sens");

    const fresh = await connect(url, { "Last-Event-ID": received.id });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(fresh.events, [], "l'id de la nouvelle génération reprend normalement");
  });

  test("après la rotation, les ajouts suivants continuent à arriver", async () => {
    const repo = squadRepo({ journal: [ev(), ev(), ev()] });
    const { url } = await runServer({ repo });
    const client = await connect(url);
    fs.renameSync(repo.events, repo.rotated);
    repo.append(ev({ agentId: "n1" }));
    await client.waitFor((events) => evtEvents(events).length === 1);
    repo.append(ev({ agentId: "n2" }));
    await client.waitFor((events) => evtEvents(events).length === 2);
    assert.deepEqual(evtEvents(client.events).map((e) => JSON.parse(e.data).agentId), ["n1", "n2"]);
  });
});

describe("GET /events : recalage GitHub", () => {
  test("un instantané est poussé à chaque intervalle, avec l'état fusionné complet", async () => {
    const repo = squadRepo({ journal: [ev({ agentId: "journal" })] });
    const { url, state } = await runServer({ repo, snapshotIntervalMs: 120 });
    const client = await connect(url);
    await client.waitFor((events) => names(events).filter((n) => n === "snapshot").length >= 2, 4000);

    const [first] = client.events.filter((e) => e.event === "snapshot");
    const data = JSON.parse(first.data);
    const current = await state();
    assert.equal(data.repo, "o/r");
    assert.deepEqual(data.agents.map((a) => a.agentId), ["journal"]);
    assert.deepEqual(Object.keys(data).sort(), Object.keys(current).sort(), "même forme que /state");
    assert.deepEqual(data.features, current.features);
    assert.ok(data.features.length > 0, "les issues du faux gh sont dans l'état");
    assert.ok(client.events.every((e) => ["evt", "snapshot", "warning"].includes(e.event)));
    assert.ok(!names(client.events).includes("warning"));
  });

  test("le recalage reprend un changement fait sur GitHub entre deux instantanés", async () => {
    const repo = squadRepo();
    const { url } = await runServer({ repo, snapshotIntervalMs: 120 });
    const client = await connect(url);
    await client.waitFor((events) => names(events).includes("snapshot"));
    const before = JSON.parse(client.events.find((e) => e.event === "snapshot").data);

    const issues = fixture("issues.json");
    setGh(okRoutes().map((r) => (r.match[0] === "issue" ? { ...r, json: issues.slice(0, 1) } : r)));
    await client.waitFor((events) =>
      events.some((e) => e.event === "snapshot" && JSON.parse(e.data).features.length < before.features.length), 4000);
    const after = JSON.parse(client.events.filter((e) => e.event === "snapshot").at(-1).data);
    assert.ok(after.features.length < before.features.length, `${before.features.length} -> ${after.features.length}`);
  });

  test("gh échoue : un `warning` {code, message, at} est poussé, sans detail ; le dernier instantané est gardé", async () => {
    const repo = squadRepo();
    const { url, state } = await runServer({ repo, snapshotIntervalMs: 120 });
    const featuresBefore = (await state()).features;
    assert.ok(featuresBefore.length > 0);

    const client = await connect(url);
    setGh([]); // aucune route : le faux gh répond « aucune réponse de fixture » sur stderr, code 1
    await client.waitFor((events) => names(events).includes("warning"), 4000);

    const warning = client.events.find((e) => e.event === "warning");
    const data = JSON.parse(warning.data);
    assert.deepEqual(Object.keys(data).sort(), ["at", "code", "message"], "jamais de detail");
    assert.equal(data.code, "GH_AUTH");
    assert.match(data.message, /gh a échoué/);
    assert.ok(!Number.isNaN(Date.parse(data.at)));
    assert.ok(!warning.data.includes("aucune réponse de fixture"), "le stderr brut de gh ne sort pas");
    assert.equal(warning.id, undefined, "un avertissement ne change pas la position dans le journal");

    const current = await state();
    assert.deepEqual(current.features, featuresBefore, "le dernier instantané est conservé");
    assert.ok(current.warnings.some((w) => w.code === "GH_AUTH"), "/state porte aussi l'avertissement");
    // Un instantané en cours au moment du changement a pu précéder le premier avertissement, aucun ne le suit.
    // Un avertissement par échec : on attend le deuxième (la durée d'un appel gh dépend de la machine).
    await client.waitFor((events) => names(events).filter((n) => n === "warning").length >= 2, 8000);
    const firstWarning = names(client.events).indexOf("warning");
    assert.ok(!names(client.events).slice(firstWarning).includes("snapshot"), "aucun instantané tant que gh échoue");
  });

  test("gh revient : un instantané est poussé et l'avertissement disparaît de l'état", async () => {
    const repo = squadRepo();
    const { url, state } = await runServer({ repo, snapshotIntervalMs: 100 });
    const client = await connect(url);
    setGh([]);
    await client.waitFor((events) => names(events).includes("warning"), 4000);
    const seen = client.events.length;

    setGh(okRoutes());
    await client.waitFor((events) => events.slice(seen).some((e) => e.event === "snapshot"), 4000);
    const snapshot = JSON.parse(client.events.slice(seen).find((e) => e.event === "snapshot").data);
    assert.ok(!snapshot.warnings.some((w) => w.code === "GH_AUTH"));
    assert.ok(!(await state()).warnings.some((w) => w.code === "GH_AUTH"));
  });

  test("gh en échec dès le démarrage : /state le signale, puis le recalage rétablit l'instantané", async () => {
    setGh([]);
    const repo = squadRepo();
    const { url, state } = await runServer({ repo, snapshotIntervalMs: 100 });
    const initial = await state();
    assert.ok(initial.warnings.some((w) => w.code === "GH_AUTH"));
    assert.ok(initial.warnings.some((w) => w.code === "SNAPSHOT_MISSING"));

    const client = await connect(url);
    await client.waitFor((events) => names(events).includes("warning"), 4000);
    setGh(okRoutes());
    await client.waitFor((events) => names(events).includes("snapshot"), 4000);
    const snapshot = JSON.parse(client.events.find((e) => e.event === "snapshot").data);
    assert.ok(snapshot.features.length > 0);
    assert.ok(!snapshot.warnings.some((w) => w.code === "SNAPSHOT_MISSING"));
  });

  test("un recalage n'en chevauche pas un autre : la tentative suivante part après la fin de la précédente", async () => {
    setGh(okRoutes().map((r) => ({ ...r, delayMs: 200 })));
    const repo = squadRepo();
    const callsBefore = fakeGh.calls().length;
    await runServer({ repo, snapshotIntervalMs: 10 });
    const startupCalls = fakeGh.calls().length - callsBefore;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const recalibrations = (fakeGh.calls().length - callsBefore - startupCalls) / 5; // 5 appels gh par instantané
    // Chaque instantané dure au moins 200 ms : au plus 7 en 1,5 s. Avec un minuteur qui se chevauche (période de
    // 10 ms), on en aurait une centaine.
    assert.ok(recalibrations <= 8, `${recalibrations} recalages en 1,5 s`);
    assert.ok(recalibrations >= 1);
  });
});

describe("GET /events : battement et libération des connexions", () => {
  test("un commentaire de battement part à chaque période, et le client SSE ne le voit pas comme un événement", async () => {
    const { url } = await runServer({ heartbeatMs: 100 });
    const received = await new Promise((resolve, reject) => {
      const req = http.get(`${url}/events`, (res) => {
        res.setEncoding("utf8");
        let text = "";
        const timer = setTimeout(() => reject(new Error(`pas de battement : ${JSON.stringify(text)}`)), 3000);
        res.on("data", (chunk) => {
          text += chunk;
          if ((text.match(/^: battement$/gm) || []).length >= 2) {
            clearTimeout(timer);
            req.destroy();
            resolve(text);
          }
        });
      });
      req.on("error", (error) => error.code === "ECONNRESET" || reject(error));
    });
    assert.match(received, /^: connecté$/m);
    assert.ok(!/^(event|data|id):/m.test(received), "des commentaires seulement");

    const client = await connect(url);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(client.events, [], "le parseur du client ignore les commentaires");
  });

  test("20 connexions/déconnexions : aucun client ne reste, et le serveur répond toujours", async () => {
    const repo = squadRepo();
    const { url, running } = await runServer({ repo, heartbeatMs: 50 });
    const listenersBefore = process.listenerCount("exit");
    for (let i = 0; i < 20; i += 1) {
      const client = await openSse(`${url}/events`);
      if (i % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      client.close();
    }
    await eventually(() => running.clientCount() === 0, `clients encore connectés : ${running.clientCount()}`);
    assert.equal(process.listenerCount("exit"), listenersBefore, "aucun écouteur de processus ajouté");

    // Le serveur continue à diffuser pour un nouveau client.
    const client = await connect(url);
    repo.append(ev());
    await client.waitFor((events) => evtEvents(events).length === 1);
    assert.equal(running.clientCount(), 1);
    client.close();
    await eventually(() => running.clientCount() === 0, "le dernier client n'est pas libéré");
  });

  test("close() coupe les flux ouverts et arrête le suivi et le recalage", async () => {
    const repo = squadRepo();
    const server = await runServer({ repo, snapshotIntervalMs: 50 });
    const client = await connect(server.url);
    await server.running.close();
    await assert.rejects(client.waitFor(() => false, 3000), /flux fermé/);
    const callsAfterClose = fakeGh.calls().length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fakeGh.calls().length, callsAfterClose, "plus aucun appel gh après close()");
  });
});
