// Tests unitaires de la CLI de viz/server.cjs (sous-commandes, options, erreurs) et de la décision « verrou vivant ou
// périmé » de viz/lib/lock.cjs. Les dépendances (vérification du pid, `kill`, horloge, pause, sonde HTTP) sont
// injectées : aucun processus n'est lancé ici (voir lifecycle.test.cjs pour les vrais processus).
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
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

describe("décision verrou vivant ou périmé (vérification du pid injectée)", () => {
  function tempLockFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-cli-lock-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, "viz.lock");
  }
  const write = (file, content) => fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  const alive = (...pids) => (pid) => pids.includes(pid);

  test("aucun fichier : none", () => {
    const file = tempLockFile();
    assert.deepEqual(lock.inspectLock(file, { isAlive: alive() }), { state: "none" });
    assert.deepEqual(lock.checkLock(file, { isAlive: alive() }), { state: "none" });
  });

  test("pid vivant : live, le verrou est conservé", () => {
    const file = tempLockFile();
    write(file, { port: 4321, pid: 777 });
    assert.deepEqual(lock.checkLock(file, { isAlive: alive(777) }), { state: "live", lock: { pid: 777, port: 4321 } });
    assert.ok(fs.existsSync(file));
  });

  test("pid mort : stale ; inspectLock ne supprime rien, checkLock supprime", () => {
    const file = tempLockFile();
    write(file, { port: 4321, pid: 777 });
    assert.deepEqual(lock.inspectLock(file, { isAlive: alive() }), { state: "stale", lock: { pid: 777, port: 4321 } });
    assert.ok(fs.existsSync(file));
    assert.deepEqual(lock.checkLock(file, { isAlive: alive() }), { state: "stale", lock: { pid: 777, port: 4321 } });
    assert.ok(!fs.existsSync(file));
  });

  test("la fonction de vérification reçoit le pid du verrou, et lui seul", () => {
    const file = tempLockFile();
    write(file, { port: 4321, pid: 777 });
    const vus = [];
    lock.checkLock(file, { isAlive: (pid) => (vus.push(pid), true) });
    assert.deepEqual(vus, [777]);
  });

  test("contenu invalide : stale sans verrou, supprimé, la vérification du pid n'est jamais appelée", () => {
    for (const content of ["{ pas du json", "", '{"pid":"777","port":4321}', '{"pid":777,"port":"x"}', '{"pid":-1,"port":4321}', "[]"]) {
      const file = tempLockFile();
      write(file, content);
      const result = lock.checkLock(file, {
        isAlive: () => {
          throw new Error("ne doit pas être appelée");
        },
      });
      assert.deepEqual(result, { state: "stale", lock: null }, content);
      assert.ok(!fs.existsSync(file), content);
    }
  });

  test("un verrou trop gros est invalide", () => {
    const file = tempLockFile();
    write(file, JSON.stringify({ port: 4321, pid: 777, padding: "x".repeat(10000) }));
    assert.deepEqual(lock.checkLock(file, { isAlive: alive(777) }), { state: "stale", lock: null });
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

describe("waitForLock (horloge injectée)", () => {
  function tempLockFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-cli-wait-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, "viz.lock");
  }

  test("rend le verrou dès qu'il est vivant, sans attendre la fin du délai", async () => {
    const file = tempLockFile();
    const clock = fakeClock();
    fs.writeFileSync(file, JSON.stringify({ port: 4321, pid: 777 }));
    const result = await lock.waitForLock(file, { seconds: 20, isAlive: () => clock.time >= 1000, now: clock.now, sleep: clock.sleep });
    assert.deepEqual(result, { state: "live", lock: { pid: 777, port: 4321 } });
    assert.equal(clock.time, 1000);
  });

  test("le verrou apparaît pendant l'attente", async () => {
    const file = tempLockFile();
    const clock = fakeClock();
    const sleep = async (ms) => {
      await clock.sleep(ms);
      if (clock.time >= 3000 && !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ port: 4321, pid: 777 }));
    };
    const result = await lock.waitForLock(file, { seconds: 20, isAlive: () => true, now: clock.now, sleep });
    assert.equal(result.state, "live");
    assert.equal(clock.time, 3000);
  });

  test("sans verrou après <s> secondes : none, après avoir attendu exactement ce délai", async () => {
    const file = tempLockFile();
    const clock = fakeClock();
    const result = await lock.waitForLock(file, { seconds: 2, isAlive: () => false, now: clock.now, sleep: clock.sleep });
    assert.deepEqual(result, { state: "none" });
    assert.equal(clock.time, 2000);
    assert.ok(clock.sleeps.every((ms) => ms > 0 && ms <= 250));
  });

  test("un verrou périmé n'est supprimé qu'à la fin du délai", async () => {
    const file = tempLockFile();
    const clock = fakeClock();
    fs.writeFileSync(file, JSON.stringify({ port: 4321, pid: 777 }));
    let existait = true;
    const sleep = async (ms) => {
      existait = existait && fs.existsSync(file);
      await clock.sleep(ms);
    };
    const result = await lock.waitForLock(file, { seconds: 1, isAlive: () => false, now: clock.now, sleep });
    assert.equal(result.state, "stale");
    assert.equal(existait, true, "le verrou est resté pendant l'attente");
    assert.ok(!fs.existsSync(file), "puis supprimé au constat final");
  });

  test("un verrou périmé remplacé par un serveur vivant pendant l'attente donne live", async () => {
    const file = tempLockFile();
    const clock = fakeClock();
    fs.writeFileSync(file, JSON.stringify({ port: 1, pid: 111 }));
    const sleep = async (ms) => {
      await clock.sleep(ms);
      if (clock.time >= 500) fs.writeFileSync(file, JSON.stringify({ port: 2, pid: 222 }));
    };
    const result = await lock.waitForLock(file, { seconds: 10, isAlive: (pid) => pid === 222, now: clock.now, sleep });
    assert.deepEqual(result, { state: "live", lock: { pid: 222, port: 2 } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Arrêt
// ---------------------------------------------------------------------------------------------------------------

describe("stopServer (kill, sonde et horloge injectés)", () => {
  function lockWith(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-cli-stop-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "viz.lock");
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
    const probes = [];
    const result = await lock.stopServer(file, {
      isAlive: proc.isAlive,
      kill: proc.kill,
      verify: async (port) => (probes.push(port), true),
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.deepEqual(result, { state: "stopped", lock: { pid: 777, port: 4321 }, forced: false });
    assert.deepEqual(proc.state.signals, [[777, "SIGTERM"]]);
    assert.deepEqual(probes, [4321]);
    assert.ok(!fs.existsSync(file));
  });

  test("attend réellement la fin du processus avant de rendre la main", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    let alive = true;
    const result = await lock.stopServer(file, {
      isAlive: () => alive,
      kill: () => {},
      verify: async () => true,
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        if (clock.time >= 400) alive = false;
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
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, verify: async () => true, now: clock.now, sleep: clock.sleep });
    assert.equal(result.state, "stopped");
    assert.equal(result.forced, true);
    assert.deepEqual(proc.state.signals, [[777, "SIGTERM"], [777, "SIGKILL"]]);
    assert.ok(!fs.existsSync(file));
  });

  test("un processus qui ne meurt pas : survived, le verrou est conservé", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    const proc = fakeProcess({ diesOn: null });
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, verify: async () => true, now: clock.now, sleep: clock.sleep });
    assert.equal(result.state, "survived");
    assert.ok(fs.existsSync(file));
  });

  test("aucun signal si le port ne répond pas comme un serveur (pid réattribué) : unverified", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const proc = fakeProcess();
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, verify: async () => false });
    assert.equal(result.state, "unverified");
    assert.deepEqual(proc.state.signals, []);
    assert.ok(fs.existsSync(file), "le verrou est conservé");
  });

  test("ne s'envoie jamais de signal à lui-même", async () => {
    const file = lockWith({ port: 4321, pid: process.pid });
    const proc = fakeProcess();
    const result = await lock.stopServer(file, { isAlive: proc.isAlive, kill: proc.kill, verify: async () => true });
    assert.equal(result.state, "unverified");
    assert.deepEqual(proc.state.signals, []);
  });

  test("ESRCH (terminé entre la vérification et le signal) : arrêté", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    let alive = true;
    const result = await lock.stopServer(file, {
      isAlive: () => alive,
      kill: () => {
        alive = false;
        throw Object.assign(new Error("kill"), { code: "ESRCH" });
      },
      verify: async () => true,
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(result.state, "stopped");
    assert.ok(!fs.existsSync(file));
  });

  test("EPERM (processus d'un autre utilisateur) : denied, le verrou est conservé", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const eperm = fakeProcess({ killError: "EPERM" });
    const denied = await lock.stopServer(file, { isAlive: eperm.isAlive, kill: eperm.kill, verify: async () => true });
    assert.equal(denied.state, "denied");
    assert.ok(fs.existsSync(file));
  });

  test("sans verrou : none ; verrou périmé : stale et supprimé ; aucun signal dans les deux cas", async () => {
    const proc = fakeProcess();
    const sans = lockWith();
    assert.deepEqual(await lock.stopServer(sans, { isAlive: proc.isAlive, kill: proc.kill }), { state: "none" });

    const perime = lockWith({ port: 4321, pid: 777 });
    proc.state.alive = false;
    const result = await lock.stopServer(perime, { isAlive: proc.isAlive, kill: proc.kill });
    assert.deepEqual(result, { state: "stale", lock: { pid: 777, port: 4321 } });
    assert.ok(!fs.existsSync(perime));
    assert.deepEqual(proc.state.signals, []);
  });

  test("ne supprime pas le verrou d'un autre serveur apparu pendant l'arrêt", async () => {
    const file = lockWith({ port: 4321, pid: 777 });
    const clock = fakeClock();
    let alive = true;
    const result = await lock.stopServer(file, {
      isAlive: () => alive,
      kill: () => {
        alive = false;
        fs.writeFileSync(file, JSON.stringify({ port: 5555, pid: 888 })); // un autre serveur a pris la place
      },
      verify: async () => true,
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

  test("status : verrou vivant -> URL sur stdout, code 0", async () => {
    const { project, lockFile } = squadProject();
    fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
    const s = sink();
    const code = await runStatus({ project }, { out: s.out, say: s.say, isAlive: (pid) => pid === 777 });
    assert.equal(code, 0);
    assert.deepEqual(s.lines.out, ["http://127.0.0.1:4321\n"]);
    assert.deepEqual(s.lines.say, []);
    assert.ok(fs.existsSync(lockFile));
  });

  test("status : verrou périmé -> code 1, verrou supprimé, rien sur stdout", async () => {
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
    const code = await runStatus({ project, wait: 20 }, { out: s.out, say: s.say, isAlive: () => true, now: clock.now, sleep });
    assert.equal(code, 0);
    assert.deepEqual(s.lines.out, ["http://127.0.0.1:4321\n"]);
    assert.equal(clock.time, 1500);
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
    let alive = true;
    const s = sink();
    const code = await runStop(
      { project },
      { say: s.say, isAlive: () => alive, kill: () => (alive = false), verify: async () => true, now: clock.now, sleep: clock.sleep },
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

  test("stop : un pid vivant qui ne répond pas comme le serveur n'est pas tué -> code 1", async () => {
    const { project, lockFile } = squadProject();
    fs.writeFileSync(lockFile, JSON.stringify({ port: 4321, pid: 777 }));
    const signals = [];
    const s = sink();
    const code = await runStop({ project }, { say: s.say, isAlive: () => true, kill: (...args) => signals.push(args), verify: async () => false });
    assert.equal(code, 1);
    assert.deepEqual(signals, []);
    assert.match(s.lines.say[0], /^error Le processus 777 existe, mais le port 4321 ne répond pas comme le serveur/);
    assert.ok(s.lines.say[0].includes(lockFile));
    assert.ok(fs.existsSync(lockFile));
  });
});
