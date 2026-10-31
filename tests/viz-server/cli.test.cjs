// Tests unitaires de la CLI de viz/server.cjs (sous-commandes, options, erreurs) et de la définition de « vivant » de
// viz/lib/lock.cjs (pid existant ET /health qui annonce ce pid : états none, live, stale, invalid). Le pid, `kill`,
// l'horloge et la sonde sont injectés, ou la sonde réelle est dirigée vers de faux serveurs HTTP locaux ; aucun serveur
// de visualisation n'est lancé ici (voir lifecycle.test.cjs pour les vrais processus).
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const { StartupError, parseCli, runStatus, runStop } = require("../../viz/server.cjs");
const lock = require("../../viz/lib/lock.cjs");
const { createTempRepo, gitCommonDir } = require("../helpers/index.cjs");

const REPO_ROOT = path.join(__dirname, "..", "..");

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

const isUsageError = (error) => error instanceof StartupError && error.exitCode === 2;

// ---------------------------------------------------------------------------------------------------------------
// parseCli
// ---------------------------------------------------------------------------------------------------------------

describe("parseCli : démarrage", () => {
  const CWD = path.resolve("dossier-courant");

  test("sans sous-commande : start, projet courant, port 0, viz/public", () => {
    const options = parseCli([], CWD);
    assert.equal(options.help, false);
    assert.equal(options.command, "start");
    assert.equal(options.project, CWD);
    assert.equal(options.port, 0);
    assert.equal(options.publicDir, path.join(REPO_ROOT, "viz", "public"));
  });

  test("start explicite équivaut à l'absence de sous-commande", () => {
    assert.deepEqual(parseCli(["start", "--port", "80"], CWD), parseCli(["--port", "80"], CWD));
    assert.equal(parseCli(["start"], CWD).command, "start");
  });

  test("--project, --port et --public-dir, chemins relatifs résolus depuis le dossier courant", () => {
    const options = parseCli(["--project", "projet", "--port", "4321", "--public-dir", "tests/fixtures/public/"], CWD);
    assert.equal(options.project, path.join(CWD, "projet"));
    assert.equal(options.port, 4321);
    assert.equal(options.publicDir, path.join(CWD, "tests", "fixtures", "public"));
  });

  test("les options peuvent précéder la sous-commande", () => {
    const options = parseCli(["--project", "p", "status"], CWD);
    assert.equal(options.command, "status");
    assert.equal(options.project, path.join(CWD, "p"));
  });

  test("--port 0 et 65535 sont acceptés ; --help et -h demandent l'aide, quelle que soit la sous-commande", () => {
    assert.equal(parseCli(["--port", "0"], CWD).port, 0);
    assert.equal(parseCli(["--port", "65535"], CWD).port, 65535);
    assert.deepEqual(parseCli(["--help"], CWD), { help: true });
    assert.deepEqual(parseCli(["-h"], CWD), { help: true });
    assert.deepEqual(parseCli(["stop", "--help"], CWD), { help: true });
  });

  test("un port invalide ou une option inconnue donnent une erreur de code 2", () => {
    const invalides = [["--port", "65536"], ["--port", "-1"], ["--port", "abc"], ["--port", "1.5"], ["--port", ""], ["--hote", "0.0.0.0"], ["--project"]];
    for (const argv of invalides) assert.throws(() => parseCli(argv, CWD), isUsageError, argv.join(" "));
  });

  test("aucune option ne permet de choisir l'adresse d'écoute ni le binaire gh", () => {
    for (const option of ["--host", "--bind", "--gh", "--gh-bin", "--exec-file"]) {
      assert.throws(() => parseCli([option, "valeur"], CWD), StartupError, option);
    }
  });
});

describe("parseCli : status et stop", () => {
  const CWD = path.resolve("dossier-courant");

  test("status : projet courant par défaut, pas d'attente", () => {
    assert.deepEqual(parseCli(["status"], CWD), { help: false, command: "status", project: CWD, wait: 0 });
  });

  test("status --project <dir> --wait <s>", () => {
    assert.deepEqual(parseCli(["status", "--project", "p", "--wait", "20"], CWD), {
      help: false,
      command: "status",
      project: path.join(CWD, "p"),
      wait: 20,
    });
    assert.equal(parseCli(["status", "--wait", "0"], CWD).wait, 0);
    assert.equal(parseCli(["status", "--wait", "1.5"], CWD).wait, 1.5);
    assert.equal(parseCli(["status", "--wait", "3600"], CWD).wait, 3600);
  });

  test("stop --project <dir>", () => {
    assert.deepEqual(parseCli(["stop", "--project", "p"], CWD), { help: false, command: "stop", project: path.join(CWD, "p") });
    assert.deepEqual(parseCli(["stop"], CWD), { help: false, command: "stop", project: CWD });
  });

  test("--wait invalide : code 2", () => {
    for (const wait of ["-1", "abc", "", "1e3", "3601", "1.2345", "0x10", " 5"]) {
      assert.throws(() => parseCli(["status", "--wait", wait], CWD), (error) => isUsageError(error) && /--wait/.test(error.message), JSON.stringify(wait));
    }
    assert.throws(() => parseCli(["status", "--wait"], CWD), isUsageError);
  });

  test("une sous-commande inconnue ou un argument en trop : code 2", () => {
    for (const argv of [["restart"], ["Status"], ["status", "extra"], ["stop", "status"], ["start", "stop"], ["x", "--project", "p"]]) {
      assert.throws(() => parseCli(argv, CWD), isUsageError, argv.join(" "));
    }
    assert.throws(() => parseCli(["restart"], CWD), /Sous-commande inconnue/);
  });

  test("une option n'est acceptée que pour la sous-commande qui l'utilise", () => {
    const refus = [
      ["status", "--port", "80"],
      ["status", "--public-dir", "x"],
      ["stop", "--port", "80"],
      ["stop", "--wait", "5"],
      ["stop", "--public-dir", "x"],
      ["start", "--wait", "5"],
      ["--wait", "5"],
    ];
    for (const argv of refus) assert.throws(() => parseCli(argv, CWD), isUsageError, argv.join(" "));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Verrou : contenu, décision vivant / périmé
// ---------------------------------------------------------------------------------------------------------------

describe("parseLock : seuls un pid et un port entiers valides sont retenus", () => {
  test("accepte {port, pid} et ignore les autres champs", () => {
    assert.deepEqual(lock.parseLock('{"port":4321,"pid":777}'), { pid: 777, port: 4321 });
    assert.deepEqual(lock.parseLock('{"port":65535,"pid":1,"cmd":"rm -rf /","url":"http://evil.example"}'), { pid: 1, port: 65535 });
  });

  test("refuse le JSON invalide, les non-objets, les types et les bornes incorrects", () => {
    const invalides = [
      "",
      "{ pas du json",
      "null",
      "[1,2]",
      '"texte"',
      "{}",
      '{"port":4321}',
      '{"pid":777}',
      '{"port":"4321","pid":777}',
      '{"port":4321,"pid":"777"}',
      '{"port":4321,"pid":"777; rm -rf /"}',
      '{"port":4321,"pid":777.5}',
      '{"port":4321,"pid":0}',
      '{"port":4321,"pid":-3}',
      '{"port":4321,"pid":1e400}',
      '{"port":4321,"pid":9007199254740993}',
      '{"port":0,"pid":777}',
      '{"port":65536,"pid":777}',
      '{"port":-1,"pid":777}',
      '{"port":80.5,"pid":777}',
      '{"port":"0.0.0.0:80","pid":777}',
    ];
    for (const text of invalides) assert.equal(lock.parseLock(text), null, text);
  });

  test("lockUrl est reconstruite sur 127.0.0.1 à partir du seul port", () => {
    assert.equal(lock.lockUrl({ pid: 1, port: 4321 }), "http://127.0.0.1:4321");
  });
});

describe("isZombieStat", () => {
  test("lit l'état après la dernière parenthèse", () => {
    assert.equal(lock.isZombieStat("123 (node) Z 1 123 123 0 -1"), true);
    assert.equal(lock.isZombieStat("123 (node) S 1 123 123 0 -1"), false);
    assert.equal(lock.isZombieStat("123 (node) R 1 123"), false);
    // le nom de commande peut contenir des parenthèses et des espaces
    assert.equal(lock.isZombieStat("123 (a) Z (b) S 1 2"), false);
    assert.equal(lock.isZombieStat("123 (a) Z (b) Z 1 2"), true);
    assert.equal(lock.isZombieStat(""), false);
    assert.equal(lock.isZombieStat("sans parenthèse"), false);
  });
});

describe("parseHealth : seul un pid entier annoncé avec ok:true est retenu", () => {
  test("accepte {ok: true, pid} et ignore les autres champs", () => {
    assert.equal(lock.parseHealth('{"ok":true,"pid":777}'), 777);
    assert.equal(lock.parseHealth('{"pid":1,"ok":true,"cmd":"rm -rf /"}'), 1);
  });

  test("refuse tout le reste : ok absent ou différent de true, pid absent, non entier ou hors borne, JSON invalide", () => {
    const invalides = [
      "",
      "{ pas du json",
      "null",
      "[]",
      '"texte"',
      '{"ok":true}',
      '{"pid":777}',
      '{"ok":false,"pid":777}',
      '{"ok":"true","pid":777}',
      '{"ok":1,"pid":777}',
      '{"ok":true,"pid":"777"}',
      '{"ok":true,"pid":"$(touch pwned)"}',
      '{"ok":true,"pid":777.5}',
      '{"ok":true,"pid":0}',
      '{"ok":true,"pid":-4}',
      '{"ok":true,"pid":null}',
      '{"ok":true,"pid":9007199254740993}',
    ];
    for (const text of invalides) assert.equal(lock.parseHealth(text), null, text);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Sondage de /health, contre de faux serveurs HTTP locaux
// ---------------------------------------------------------------------------------------------------------------

/** Faux serveur HTTP sur 127.0.0.1 ; rend son port. Tout est coupé au nettoyage, même une réponse jamais terminée. */
async function fakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: server.address().port, requests };
}

const sendJson = (body, status = 200) => (req, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const never = () => {}; // n'écrit jamais la réponse
const closeAtOnce = (req) => req.socket.destroy();

/** Corps JSON valide de `size` octets exactement. */
function healthBodyOfSize(size, pid = 777) {
  const base = JSON.stringify({ ok: true, pid, pad: "" });
  return JSON.stringify({ ok: true, pid, pad: "x".repeat(size - Buffer.byteLength(base)) });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe("probeHealth (faux serveur HTTP)", () => {
  test("limites par défaut : 1 s et 1 Ko", () => {
    assert.equal(lock.PROBE_TIMEOUT_MS, 1000);
    assert.equal(lock.MAX_HEALTH_BYTES, 1024);
  });

  test("rend le pid annoncé, par un GET /health uniquement", async () => {
    const server = await fakeServer(sendJson({ ok: true, pid: 777 }));
    assert.equal(await lock.probeHealth(server.port), 777);
    assert.deepEqual(server.requests, ["GET /health"]);
  });

  test("rend le pid d'un autre processus tel quel (c'est l'appelant qui compare)", async () => {
    const server = await fakeServer(sendJson({ ok: true, pid: 888 }));
    assert.equal(await lock.probeHealth(server.port), 888);
  });

  test("réponse sans pid, avec ok faux, avec un pid invalide ou qui n'est pas du JSON : null", async () => {
    for (const body of [{ ok: true }, { ok: false, pid: 777 }, { ok: true, pid: "777" }, { ok: true, pid: 0 }, "bonjour", "", "[]"]) {
      const server = await fakeServer(sendJson(body));
      assert.equal(await lock.probeHealth(server.port), null, JSON.stringify(body));
    }
  });

  test("un statut autre que 200 donne null, même avec un corps valide", async () => {
    for (const status of [201, 404, 421, 500]) {
      const server = await fakeServer(sendJson({ ok: true, pid: 777 }, status));
      assert.equal(await lock.probeHealth(server.port), null, String(status));
    }
  });

  test("une redirection n'est pas suivie", async () => {
    const cible = await fakeServer(sendJson({ ok: true, pid: 777 }));
    const server = await fakeServer((req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${cible.port}/health` });
      res.end();
    });
    assert.equal(await lock.probeHealth(server.port), null);
    assert.deepEqual(cible.requests, [], "la cible de la redirection n'est jamais contactée");
  });

  test("serveur muet (connexion coupée) ou port fermé : null", async () => {
    const server = await fakeServer(closeAtOnce);
    assert.equal(await lock.probeHealth(server.port), null);
    assert.equal(await lock.probeHealth(await freePort()), null);
  });

  test("serveur qui ne répond jamais : null au bout du délai, sans attendre davantage", async () => {
    const server = await fakeServer(never);
    const debut = Date.now();
    assert.equal(await lock.probeHealth(server.port, 200), null);
    const duree = Date.now() - debut;
    assert.ok(duree >= 150 && duree < 2000, `sondage rendu après ${duree} ms`);
  });

  test("le délai borne la durée totale, même pour un serveur qui répond au compte-gouttes", async () => {
    let timer;
    const server = await fakeServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"ok":true,');
      timer = setInterval(() => res.write(" "), 30);
      res.on("close", () => clearInterval(timer));
    });
    cleanups.push(() => clearInterval(timer));
    const debut = Date.now();
    assert.equal(await lock.probeHealth(server.port, 300), null);
    const duree = Date.now() - debut;
    assert.ok(duree >= 250 && duree < 2000, `sondage rendu après ${duree} ms`);
  });

  test("le délai par défaut est de 1 s", async () => {
    const server = await fakeServer(never);
    const debut = Date.now();
    assert.equal(await lock.probeHealth(server.port), null);
    const duree = Date.now() - debut;
    assert.ok(duree >= 900 && duree < 3000, `sondage rendu après ${duree} ms`);
  });

  test("un corps de plus de 1 Ko est ignoré ; 1 Ko pile reste accepté", async () => {
    const pile = await fakeServer(sendJson(healthBodyOfSize(1024)));
    assert.equal(await lock.probeHealth(pile.port), 777);
    const trop = await fakeServer(sendJson(healthBodyOfSize(1025)));
    assert.equal(await lock.probeHealth(trop.port), null);
    const enorme = await fakeServer(sendJson(healthBodyOfSize(200000)));
    assert.equal(await lock.probeHealth(enorme.port), null);
  });

  test("un flux sans fin est coupé dès que la limite est dépassée, sans attendre le délai", async () => {
    let timer;
    const server = await fakeServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      timer = setInterval(() => res.write("x".repeat(400)), 5);
      res.on("close", () => clearInterval(timer));
    });
    cleanups.push(() => clearInterval(timer));
    const debut = Date.now();
    assert.equal(await lock.probeHealth(server.port, 5000), null);
    assert.ok(Date.now() - debut < 2500);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Verrou : décision none / live / stale / invalid
// ---------------------------------------------------------------------------------------------------------------

function tempLockFile(prefix = "gepet-cli-lock-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "viz.lock");
}
const alive = (...pids) => (pid) => pids.includes(pid);
/** Sonde simulée : /health annonce `pid` (null : muet ou incohérent). Mémorise les ports sondés. */
const answers = (pid) => {
  const probe = async (port) => (probe.ports.push(port), pid);
  probe.ports = [];
  return probe;
};
const mustNotRun = (nom) => () => {
  throw new Error(`${nom} ne doit pas être appelée`);
};

describe("décision verrou none / live / stale / invalid (pid et /health simulés)", () => {
  const write = (file, content) => fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));

  test("aucun fichier : none, sans rien sonder", async () => {
    const file = tempLockFile();
    const deps = { isAlive: mustNotRun("isAlive"), probe: mustNotRun("probe") };
    assert.deepEqual(await lock.inspectLock(file, deps), { state: "none" });
    assert.deepEqual(await lock.checkLock(file, deps), { state: "none" });
  });

  test("pid vivant ET /health avec ce pid : live, sur le port du verrou ; le verrou est conservé", async () => {
    const file = tempLockFile();
    write(file, { port: 4321, pid: 777 });
    const probe = answers(777);
    assert.deepEqual(await lock.checkLock(file, { isAlive: alive(777), probe }), { state: "live", lock: { pid: 777, port: 4321 } });
    assert.deepEqual(probe.ports, [4321]);
    assert.ok(fs.existsSync(file));
  });

  test("pid mort : stale (dead), /health n'est pas sondé ; inspectLock ne supprime rien, checkLock supprime", async () => {
    const file = tempLockFile();
    write(file, { port: 4321, pid: 777 });
    const attendu = { state: "stale", lock: { pid: 777, port: 4321 }, reason: "dead" };
    const deps = { isAlive: alive(), probe: mustNotRun("probe") };
    assert.deepEqual(await lock.inspectLock(file, deps), attendu);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(await lock.checkLock(file, deps), attendu);
    assert.ok(!fs.existsSync(file));
  });

  test("pid vivant mais /health muet, hors délai ou sans pid (sonde : null) : stale (unanswered), verrou supprimé par checkLock", async () => {
    const file = tempLockFile();
    write(file, { port: 4321, pid: 777 });
    const attendu = { state: "stale", lock: { pid: 777, port: 4321 }, reason: "unanswered" };
    assert.deepEqual(await lock.inspectLock(file, { isAlive: alive(777), probe: answers(null) }), attendu);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(await lock.checkLock(file, { isAlive: alive(777), probe: answers(null) }), attendu);
    assert.ok(!fs.existsSync(file));
  });

  test("pid vivant mais /health annonce un autre pid : stale (unanswered)", async () => {
    const file = tempLockFile();
    write(file, { port: 4321, pid: 777 });
    const result = await lock.checkLock(file, { isAlive: alive(777), probe: answers(888) });
    assert.deepEqual(result, { state: "stale", lock: { pid: 777, port: 4321 }, reason: "unanswered" });
    assert.ok(!fs.existsSync(file));
  });

  test("contenu corrompu : invalid sans verrou, supprimé par checkLock, ni le pid ni /health ne sont consultés", async () => {
    for (const content of ["{ pas du json", "", '{"pid":"777","port":4321}', '{"pid":777,"port":"x"}', '{"pid":-1,"port":4321}', "[]"]) {
      const file = tempLockFile();
      write(file, content);
      const deps = { isAlive: mustNotRun("isAlive"), probe: mustNotRun("probe") };
      assert.deepEqual(await lock.inspectLock(file, deps), { state: "invalid", lock: null }, content);
      assert.ok(fs.existsSync(file), content);
      assert.deepEqual(await lock.checkLock(file, deps), { state: "invalid", lock: null }, content);
      assert.ok(!fs.existsSync(file), content);
    }
  });

  test("un verrou trop gros est invalide", async () => {
    const file = tempLockFile();
    write(file, JSON.stringify({ port: 4321, pid: 777, padding: "x".repeat(10000) }));
    const deps = { isAlive: alive(777), probe: mustNotRun("probe") };
    assert.deepEqual(await lock.checkLock(file, deps), { state: "invalid", lock: null });
    assert.ok(!fs.existsSync(file));
  });

  test("un verrou remplacé pendant le sondage (nouveau serveur) n'est pas supprimé", async () => {
    const file = tempLockFile();
    write(file, { port: 4321, pid: 777 });
    const probe = async () => {
      write(file, { port: 5555, pid: 888 }); // un autre serveur prend la place pendant qu'on sonde l'ancien
      return null;
    };
    const result = await lock.checkLock(file, { isAlive: alive(777, 888), probe });
    assert.equal(result.state, "stale");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { port: 5555, pid: 888 });
  });

  test("acquireLock : un verrou vivant est refusé, un verrou périmé est remplacé", () => {
    const file = tempLockFile();
    write(file, { port: 1111, pid: 777 });
    assert.throws(() => lock.acquireLock(file, 2222, 5, { isAlive: alive(777) }), (error) => error instanceof lock.LockHeldError && error.lock.port === 1111);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 777);
    lock.acquireLock(file, 2222, 5, { isAlive: alive() });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { port: 2222, pid: 5 });
  });

  test("isPidAlive refuse tout ce qui n'est pas un pid entier positif", () => {
    assert.equal(lock.isPidAlive(process.pid), true);
    for (const pid of [0, -5, 1.5, "12", null, undefined, NaN, Infinity, 2 ** 53]) assert.equal(lock.isPidAlive(pid), false, String(pid));
  });
});

describe("inspectLock avec un faux serveur /health réel (pid vivant : celui du test)", () => {
  // Le pid du verrou est celui du test (vivant, vérifié par `isPidAlive`) ; seul le faux /health change.
  const cas = [
    { nom: "bon pid", handler: () => sendJson({ ok: true, pid: process.pid }), state: "live" },
    { nom: "autre pid", handler: () => sendJson({ ok: true, pid: process.pid + 1 }), state: "stale" },
    { nom: "{ok: true} sans pid", handler: () => sendJson({ ok: true }), state: "stale" },
    { nom: "pid sous forme de texte", handler: () => sendJson({ ok: true, pid: String(process.pid) }), state: "stale" },
    { nom: "serveur muet (connexion coupée)", handler: () => closeAtOnce, state: "stale" },
    { nom: "corps de plus de 1 Ko", handler: () => sendJson(healthBodyOfSize(2048, process.pid)), state: "stale" },
    { nom: "statut 500", handler: () => sendJson({ ok: true, pid: process.pid }, 500), state: "stale" },
  ];
  for (const { nom, handler, state } of cas) {
    test(`${nom} : ${state}`, async () => {
      const server = await fakeServer(handler());
      const file = tempLockFile();
      fs.writeFileSync(file, JSON.stringify({ port: server.port, pid: process.pid }));
      const result = await lock.inspectLock(file);
      assert.equal(result.state, state);
      if (state === "stale") assert.equal(result.reason, "unanswered");
      assert.deepEqual(server.requests, ["GET /health"]);
    });
  }

  test("serveur hors délai (aucune réponse) : stale au bout d'environ 1 s", async () => {
    const server = await fakeServer(never);
    const file = tempLockFile();
    fs.writeFileSync(file, JSON.stringify({ port: server.port, pid: process.pid }));
    const debut = Date.now();
    const result = await lock.inspectLock(file);
    assert.equal(result.state, "stale");
    assert.ok(Date.now() - debut < 3000);
  });

  test("port fermé : stale", async () => {
    const file = tempLockFile();
    fs.writeFileSync(file, JSON.stringify({ port: await freePort(), pid: process.pid }));
    assert.equal((await lock.inspectLock(file)).state, "stale");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Attente
// ---------------------------------------------------------------------------------------------------------------

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get time() {
      return t;
    },
  };
}

describe("waitForLock (horloge, pid et /health simulés)", () => {
  test("rend le verrou dès que le serveur est vivant, sans attendre la fin du délai", async () => {
    const file = tempLockFile("gepet-cli-wait-");
    const clock = fakeClock();
    fs.writeFileSync(file, JSON.stringify({ port: 4321, pid: 777 }));
    // Le pid existe dès le début, mais /health ne répond avec le bon pid qu'à partir de 1 s.
    const probe = async () => (clock.time >= 1000 ? 777 : null);
    const result = await lock.waitForLock(file, { seconds: 20, isAlive: () => true, probe, now: clock.now, sleep: clock.sleep });
    assert.deepEqual(result, { state: "live", lock: { pid: 777, port: 4321 } });
    assert.equal(clock.time, 1000);
  });

  test("le verrou apparaît pendant l'attente", async () => {
    const file = tempLockFile("gepet-cli-wait-");
    const clock = fakeClock();
    const sleep = async (ms) => {
      await clock.sleep(ms);
      if (clock.time >= 3000 && !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ port: 4321, pid: 777 }));
    };
    const result = await lock.waitForLock(file, { seconds: 20, isAlive: () => true, probe: answers(777), now: clock.now, sleep });
    assert.equal(result.state, "live");
    assert.equal(clock.time, 3000);
  });

  test("sans verrou après <s> secondes : none, après avoir attendu exactement ce délai", async () => {
    const file = tempLockFile("gepet-cli-wait-");
    const clock = fakeClock();
    const result = await lock.waitForLock(file, { seconds: 2, isAlive: () => false, probe: answers(null), now: clock.now, sleep: clock.sleep });
    assert.deepEqual(result, { state: "none" });
    assert.equal(clock.time, 2000);
    assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 250));
  });

  test("un verrou périmé n'est supprimé qu'à la fin du délai", async () => {
    const file = tempLockFile("gepet-cli-wait-");
    const clock = fakeClock();
    fs.writeFileSync(file, JSON.stringify({ port: 4321, pid: 777 }));
    let existait = true;
    const sleep = async (ms) => {
      existait = existait && fs.existsSync(file);
      await clock.sleep(ms);
    };
    const result = await lock.waitForLock(file, { seconds: 1, isAlive: () => false, probe: answers(null), now: clock.now, sleep });
    assert.equal(result.state, "stale");
    assert.equal(existait, true, "le verrou est resté pendant l'attente");
    assert.ok(!fs.existsSync(file), "puis supprimé au constat final");
  });

  test("un pid vivant dont /health annonce un autre pid n'est jamais live : stale à la fin du délai", async () => {
    const file = tempLockFile("gepet-cli-wait-");
    const clock = fakeClock();
    fs.writeFileSync(file, JSON.stringify({ port: 4321, pid: 777 }));
    const result = await lock.waitForLock(file, { seconds: 2, isAlive: () => true, probe: answers(888), now: clock.now, sleep: clock.sleep });
    assert.deepEqual(result, { state: "stale", lock: { pid: 777, port: 4321 }, reason: "unanswered" });
    assert.equal(clock.time, 2000);
    assert.ok(!fs.existsSync(file));
  });

  test("un verrou périmé remplacé par un serveur vivant pendant l'attente donne live", async () => {
    const file = tempLockFile("gepet-cli-wait-");
    const clock = fakeClock();
    fs.writeFileSync(file, JSON.stringify({ port: 1, pid: 111 }));
    const sleep = async (ms) => {
      await clock.sleep(ms);
      if (clock.time >= 500) fs.writeFileSync(file, JSON.stringify({ port: 2, pid: 222 }));
    };
    const probe = async (port) => (port === 2 ? 222 : null);
    const result = await lock.waitForLock(file, { seconds: 10, isAlive: (pid) => pid === 222, probe, now: clock.now, sleep });
    assert.deepEqual(result, { state: "live", lock: { pid: 222, port: 2 } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Arrêt
// ---------------------------------------------------------------------------------------------------------------

describe("stopServer (kill, sonde et horloge injectés)", () => {
  function lockWith(content) {
    const file = tempLockFile("gepet-cli-stop-");
    if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content));
    return file;
  }

  /** Processus simulé : vivant jusqu'à ce qu'il reçoive `diesOn` ; `diesOn: null` = ne meurt jamais. */
  function fakeProcess({ diesOn = "SIGTERM", killError = null } = {}) {
    const state = { alive: true, signals: [] };
    return {
      state,
      isAlive: () => state.alive,
      kill: (pid, signal) => {
        state.signals.push([pid, signal]);
        if (killError) throw Object.assign(new Error("kill"), { code: killError });
        if (signal === diesOn) state.alive = false;
      },
    };
  }

  test("SIGTERM, attente de la fin, suppression du verrou", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    const proc = fakeProcess();
    const probe = answers(777);
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, probe, now: clock.now, sleep: clock.sleep });
    assert.deepEqual(result, { state: "stopped", lock: { pid: 777, port: 4321 }, forced: false });
    assert.deepEqual(proc.state.signals, [[777, "SIGTERM"]]);
    assert.deepEqual(probe.ports, [4321]);
    assert.ok(!fs.existsSync(file));
  });

  test("attend réellement la fin du processus avant de rendre la main", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    let vivant = true;
    const result = await lock.stopServer(file, {
      isAlive: () => vivant,
      kill: () => {},
      probe: answers(777),
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        if (clock.time >= 400) vivant = false;
      },
    });
    assert.equal(result.state, "stopped");
    assert.ok(clock.time >= 400);
    assert.equal(result.forced, false);
  });

  test("le processus qui ignore SIGTERM reçoit SIGKILL", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    const proc = fakeProcess({ diesOn: "SIGKILL" });
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, probe: answers(777), now: clock.now, sleep: clock.sleep });
    assert.equal(result.state, "stopped");
    assert.equal(result.forced, true);
    assert.deepEqual(proc.state.signals, [[777, "SIGTERM"], [777, "SIGKILL"]]);
    assert.ok(!fs.existsSync(file));
  });

  test("un processus qui ne meurt pas : survived, le verrou est conservé", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    const proc = fakeProcess({ diesOn: null });
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, probe: answers(777), now: clock.now, sleep: clock.sleep });
    assert.equal(result.state, "survived");
    assert.ok(fs.existsSync(file));
  });

  test("aucun signal si /health est muet (pid réattribué) : stale, verrou supprimé", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const proc = fakeProcess();
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, probe: answers(null) });
    assert.deepEqual(result, { state: "stale", lock: { pid: 777, port: 4321 }, reason: "unanswered" });
    assert.deepEqual(proc.state.signals, []);
    assert.ok(!fs.existsSync(file));
  });

  test("aucun signal si /health annonce un autre pid (faux serveur sur le port du verrou)", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const proc = fakeProcess();
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, probe: answers(888) });
    assert.equal(result.state, "stale");
    assert.deepEqual(proc.state.signals, []);
    assert.ok(proc.state.alive);
  });

  test("ne s'envoie jamais de signal à lui-même : self, verrou conservé", async () => {
    const file = lockWith({ port: 4321, pid: process.pid });
    const proc = fakeProcess();
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, probe: answers(process.pid) });
    assert.deepEqual(result, { state: "self", lock: { pid: process.pid, port: 4321 } });
    assert.deepEqual(proc.state.signals, []);
    assert.ok(fs.existsSync(file));
  });

  test("ESRCH (terminé entre la vérification et le signal) : arrêté", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    let vivant = true;
    const result = await lock.stopServer(file, {
      isAlive: () => vivant,
      kill: () => {
        vivant = false;
        throw Object.assign(new Error("kill"), { code: "ESRCH" });
      },
      probe: answers(777),
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(result.state, "stopped");
    assert.ok(!fs.existsSync(file));
  });

  test("EPERM (processus d'un autre utilisateur) : denied, le verrou est conservé", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const eperm = fakeProcess({ killError: "EPERM" });
    const denied = await lock.stopServer(file, { isAlive: eperm.isAlive, kill: eperm.kill, probe: answers(777) });
    assert.equal(denied.state, "denied");
    assert.ok(fs.existsSync(file));
  });

  test("sans verrou : none ; pid mort : stale (dead) ; contenu corrompu : invalid ; verrous nettoyés, aucun signal", async () => {
    const proc = fakeProcess();
    const deps = { isAlive: proc.isAlive, kill: proc.kill, probe: mustNotRun("probe") };
    assert.deepEqual(await lock.stopServer(lockWith(), deps), { state: "none" });

    const perime = lockWith({ port: 4321, pid: 777 });
    proc.state.alive = false;
    assert.deepEqual(await lock.stopServer(perime, deps), { state: "stale", lock: { pid: 777, port: 4321 }, reason: "dead" });
    assert.ok(!fs.existsSync(perime));

    const corrompu = lockWith();
    fs.writeFileSync(corrompu, "{ pas du json");
    assert.deepEqual(await lock.stopServer(corrompu, deps), { state: "invalid", lock: null });
    assert.ok(!fs.existsSync(corrompu));
    assert.deepEqual(proc.state.signals, []);
  });

  test("ne supprime pas le verrou d'un autre serveur apparu pendant l'arrêt", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    let vivant = true;
    const result = await lock.stopServer(file, {
      isAlive: () => vivant,
      kill: () => {
        vivant = false;
        fs.writeFileSync(file, JSON.stringify({ port: 5555, pid: 888 })); // un autre serveur a pris la place
      },
      probe: answers(777),
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(result.state, "stopped");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { port: 5555, pid: 888 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Commandes status et stop : messages et codes de sortie
// ---------------------------------------------------------------------------------------------------------------

describe("runStatus et runStop (sorties et codes de sortie)", () => {
  function squadProject() {
    const repo = createTempRepo();
    cleanups.push(repo.cleanup);
    fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), JSON.stringify({ version: 1, repo: "o/r" }));
    const dir = path.join(gitCommonDir(repo.dir), "gepet-squad");
    fs.mkdirSync(dir, { recursive: true });
    return { project: repo.dir, lockFile: path.join(dir, "viz.lock") };
  }
  function sink() {
    const lines = { out: [], say: [] };
    return { lines, out: (text) => lines.out.push(text), say: (level, message) => lines.say.push(`${level} ${message}`) };
  }

  test("status : verrou vivant (pid et /health) -> URL sur stdout, code 0", async () => {
    const { project, lockFile } = squadProject();
    fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
    const s = sink();
    const code = await runStatus({ project }, { out: s.out, say: s.say, isAlive: alive(777), probe: answers(777) });
    assert.equal(code, 0);
    assert.deepEqual(s.lines.out, ["http://127.0.0.1:4321\n"]);
    assert.deepEqual(s.lines.say, []);
    assert.ok(fs.existsSync(lockFile));
  });

  test("status : pid mort -> code 1, verrou supprimé, rien sur stdout", async () => {
    const { project, lockFile } = squadProject();
    fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
    const s = sink();
    const code = await runStatus({ project }, { out: s.out, say: s.say, isAlive: () => false });
    assert.equal(code, 1);
    assert.deepEqual(s.lines.out, []);
    assert.match(s.lines.say[0], /^warn Verrou périmé supprimé : le processus 777 n'existe plus/);
    assert.match(s.lines.say[1], /^error Aucun serveur lancé/);
    assert.ok(!fs.existsSync(lockFile));
  });

  test("status : pid vivant mais /health muet ou avec un autre pid -> code 1, aucune URL, verrou supprimé", async () => {
    for (const reported of [null, 888]) {
      const { project, lockFile } = squadProject();
      fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
      const s = sink();
      const code = await runStatus({ project }, { out: s.out, say: s.say, isAlive: () => true, probe: answers(reported) });
      assert.equal(code, 1, String(reported));
      assert.deepEqual(s.lines.out, [], "aucune URL morte n'est affichée");
      assert.match(s.lines.say[0], /^warn Verrou périmé supprimé .*: le processus 777 existe, mais le port 4321 ne répond pas comme son serveur/);
      assert.match(s.lines.say[1], /^error Aucun serveur lancé/);
      assert.ok(!fs.existsSync(lockFile));
    }
  });

  test("status : verrou corrompu -> code 1, verrou supprimé, message dédié", async () => {
    const { project, lockFile } = squadProject();
    fs.writeFileSync(lockFile, "{ pas du json");
    const s = sink();
    assert.equal(await runStatus({ project }, { out: s.out, say: s.say }), 1);
    assert.deepEqual(s.lines.out, []);
    assert.match(s.lines.say[0], /^warn Verrou illisible ou invalide supprimé/);
    assert.ok(!fs.existsSync(lockFile));
  });

  test("status : pas de verrou -> code 1 ; avec --wait, le message mentionne le délai", async () => {
    const { project } = squadProject();
    const s = sink();
    assert.equal(await runStatus({ project }, { out: s.out, say: s.say }), 1);
    assert.deepEqual(s.lines.say, ["error Aucun serveur lancé pour ce projet."]);

    const clock = fakeClock();
    const w = sink();
    assert.equal(await runStatus({ project, wait: 3 }, { out: w.out, say: w.say, now: clock.now, sleep: clock.sleep }), 1);
    assert.deepEqual(w.lines.say, ["error Aucun serveur lancé pour ce projet (attendu 3 s)."]);
    assert.equal(clock.time, 3000);
  });

  test("status --wait : le serveur apparaît avant la fin du délai -> code 0", async () => {
    const { project, lockFile } = squadProject();
    const clock = fakeClock();
    const s = sink();
    const sleep = async (ms) => {
      await clock.sleep(ms);
      if (clock.time >= 1500) fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
    };
    const code = await runStatus({ project, wait: 20 }, { out: s.out, say: s.say, isAlive: () => true, probe: answers(777), now: clock.now, sleep });
    assert.equal(code, 0);
    assert.deepEqual(s.lines.out, ["http://127.0.0.1:4321\n"]);
    assert.equal(clock.time, 1500);
  });

  test("status --wait : un pid vivant dont /health ne répond pas ne donne jamais d'URL -> code 1 après le délai", async () => {
    const { project, lockFile } = squadProject();
    fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
    const clock = fakeClock();
    const s = sink();
    const code = await runStatus({ project, wait: 2 }, { out: s.out, say: s.say, isAlive: () => true, probe: answers(null), now: clock.now, sleep: clock.sleep });
    assert.equal(code, 1);
    assert.deepEqual(s.lines.out, []);
    assert.equal(clock.time, 2000);
    assert.ok(!fs.existsSync(lockFile));
  });

  test("status : un dossier qui n'est pas un projet squad lève une StartupError claire", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-cli-sansconfig-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    await assert.rejects(runStatus({ project: dir }), (error) => error instanceof StartupError && /\.gepet-squad\.json introuvable/.test(error.message) && error.exitCode === 1);
    await assert.rejects(runStop({ project: dir }), StartupError);
  });

  test("stop : serveur arrêté -> code 0 et message", async () => {
    const { project, lockFile } = squadProject();
    fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
    const clock = fakeClock();
    let vivant = true;
    const s = sink();
    const code = await runStop(
      { project },
      { say: s.say, isAlive: () => vivant, kill: () => (vivant = false), probe: answers(777), now: clock.now, sleep: clock.sleep },
    );
    assert.equal(code, 0);
    assert.deepEqual(s.lines.say, ["info Serveur arrêté (pid 777, port 4321)."]);
    assert.ok(!fs.existsSync(lockFile));
  });

  test("stop : sans serveur vivant -> code 1 et message clair ; verrou périmé nettoyé", async () => {
    const { project, lockFile } = squadProject();
    const s = sink();
    assert.equal(await runStop({ project }, { say: s.say }), 1);
    assert.deepEqual(s.lines.say, ["error Aucun serveur lancé pour ce projet."]);

    fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
    const p = sink();
    assert.equal(await runStop({ project }, { say: p.say, isAlive: () => false }), 1);
    assert.match(p.lines.say[0], /^warn Verrou périmé supprimé/);
    assert.match(p.lines.say[1], /^error Aucun serveur lancé/);
    assert.ok(!fs.existsSync(lockFile));
  });

  test("stop : un pid vivant dont /health ne répond pas ou annonce un autre pid n'est pas tué -> code 1, verrou nettoyé", async () => {
    for (const reported of [null, 888]) {
      const { project, lockFile } = squadProject();
      fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
      const signals = [];
      const s = sink();
      const code = await runStop({ project }, { say: s.say, isAlive: () => true, kill: (...args) => signals.push(args), probe: answers(reported) });
      assert.equal(code, 1, String(reported));
      assert.deepEqual(signals, []);
      assert.match(s.lines.say[0], /^warn Verrou périmé supprimé .*: le processus 777 existe, mais le port 4321 ne répond pas comme son serveur/);
      assert.ok(s.lines.say[0].includes(lockFile), "le message indique le fichier de verrou");
      assert.match(s.lines.say[1], /^warn Aucun signal n'a été envoyé au processus 777/);
      assert.match(s.lines.say[2], /^error Aucun serveur lancé/);
      assert.ok(!fs.existsSync(lockFile));
    }
  });

  test("stop : verrou corrompu -> code 1 et verrou supprimé", async () => {
    const { project, lockFile } = squadProject();
    fs.writeFileSync(lockFile, "[]");
    const s = sink();
    assert.equal(await runStop({ project }, { say: s.say }), 1);
    assert.match(s.lines.say[0], /^warn Verrou illisible ou invalide supprimé/);
    assert.ok(!fs.existsSync(lockFile));
  });
});
