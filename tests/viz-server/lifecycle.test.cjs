// Cycle de vie du serveur (F-15) : un serveur réel (`node viz/server.cjs`, faux `gh`, repo git temporaire) puis les
// sous-commandes `status` et `stop` et un second démarrage, tous lancés comme des processus indépendants, sur Linux
// et Windows. Les décisions fines (pid vivant ou périmé, SIGTERM puis SIGKILL, horloge) sont dans cli.test.cjs.
//
// Les commandes `status` et `stop` sont lancées en asynchrone (jamais spawnSync) : le serveur est un processus fils du
// test, et tant que la boucle d'événements du test ne tourne pas il reste zombie après son arrêt, donc « vivant »
// pour `kill(pid, 0)`.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { createTempRepo, gitCommonDir, installFakeGh } = require("../helpers/index.cjs");
const { PUBLIC_REL, ghFixtureRoutes, startVizProcess, spawnVizCli, runVizCli } = require("../helpers/viz-process.cjs");
const { isPidAlive } = require("../../viz/lib/lock.cjs");

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

/** Repo git temporaire configuré pour la squad (`o/r`), sans journal. */
function squadRepo() {
  const repo = createTempRepo();
  cleanups.push(repo.cleanup);
  fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), JSON.stringify({ version: 1, repo: "o/r" }));
  const dir = path.join(gitCommonDir(repo.dir), "gepet-squad");
  fs.mkdirSync(dir, { recursive: true });
  return { ...repo, lockFile: path.join(dir, "viz.lock") };
}

function fakeGh() {
  const fake = installFakeGh({ routes: ghFixtureRoutes() });
  cleanups.push(fake.cleanup);
  return fake;
}

/** Démarre un vrai serveur et attend qu'il écoute. */
async function runningServer(repo = squadRepo(), fake = fakeGh()) {
  const proc = startVizProcess({ project: repo.dir, fake });
  cleanups.push(() => proc.child.kill("SIGKILL"));
  const port = await proc.ready;
  return { repo, fake, proc, port, url: `http://127.0.0.1:${port}` };
}

const projectArgs = (repo, ...rest) => [...rest, "--project", repo.dir];
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLockFile = (repo) => JSON.parse(fs.readFileSync(repo.lockFile, "utf8"));

/** Port sur lequel plus rien n'écoute. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Processus étranger qui reste vivant (il n'est pas un serveur de visualisation). */
function bystander() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  cleanups.push(() => child.kill("SIGKILL"));
  return child;
}

describe("status (intégration, sous-processus)", () => {
  test("serveur vivant : affiche l'URL sur stdout et sort avec 0", async () => {
    const { repo, url } = await runningServer();
    const result = await runVizCli(projectArgs(repo, "status"));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${url}\n`);
    assert.equal(result.stderr, "");
    assert.ok(fs.existsSync(repo.lockFile), "status ne touche pas au verrou d'un serveur vivant");
  });

  test("sans serveur : code 1, message clair, rien sur stdout", async () => {
    const repo = squadRepo();
    const result = await runVizCli(projectArgs(repo, "status"));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /\[gepet-squad-viz\] error Aucun serveur lancé pour ce projet\./);
  });

  test("verrou périmé (pid inexistant) : code 1 et verrou supprimé", async () => {
    const repo = squadRepo();
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port: 4321, pid: deadPid() }));
    const result = await runVizCli(projectArgs(repo, "status"));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /warn Verrou périmé supprimé/);
    assert.match(result.stderr, /error Aucun serveur lancé/);
    assert.ok(!fs.existsSync(repo.lockFile), "le verrou périmé doit être supprimé");
  });

  test("le --project peut être un sous-dossier du projet", async () => {
    const { repo, url } = await runningServer();
    const sub = path.join(repo.dir, "src");
    fs.mkdirSync(sub);
    const result = await runVizCli(["status", "--project", sub]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${url}\n`);
  });

  test("un dossier qui n'est pas un projet squad : code 1 et message clair", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-sansconfig-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = await runVizCli(["status", "--project", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error \.gepet-squad\.json introuvable/);
  });

  test("option invalide : code 2 et usage", async () => {
    const repo = squadRepo();
    const wait = await runVizCli(projectArgs(repo, "status", "--wait", "abc"));
    assert.equal(wait.code, 2);
    assert.match(wait.stderr, /--wait doit être un nombre de secondes/);
    const port = await runVizCli(projectArgs(repo, "status", "--port", "80"));
    assert.equal(port.code, 2);
    const inconnue = await runVizCli(["redemarrer"]);
    assert.equal(inconnue.code, 2);
    assert.match(inconnue.stderr, /Sous-commande inconnue/);
  });
});

describe("status --wait (intégration, sous-processus)", () => {
  test("attend l'apparition d'un serveur vivant, puis affiche son URL", async () => {
    const repo = squadRepo();
    const fake = fakeGh();
    const waiting = spawnVizCli(projectArgs(repo, "status", "--wait", "30"));
    cleanups.push(() => waiting.child.kill("SIGKILL"));
    let finished = false;
    waiting.done.then(() => (finished = true));

    await sleep(800);
    assert.equal(finished, false, "status attend tant qu'aucun serveur n'existe");

    const proc = startVizProcess({ project: repo.dir, fake });
    cleanups.push(() => proc.child.kill("SIGKILL"));
    const port = await proc.ready;

    const result = await waiting.done;
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${port}\n`);
  });

  test("sans serveur après le délai : code 1, et pas avant la fin du délai", async () => {
    const repo = squadRepo();
    const started = Date.now();
    const result = await runVizCli(projectArgs(repo, "status", "--wait", "1"));
    const elapsed = Date.now() - started;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Aucun serveur lancé pour ce projet \(attendu 1 s\)\./);
    assert.ok(elapsed >= 900, `status a rendu la main après ${elapsed} ms`);
  });

  test("un serveur déjà vivant répond tout de suite, sans attendre le délai", async () => {
    const { repo, url } = await runningServer();
    const started = Date.now();
    const result = await runVizCli(projectArgs(repo, "status", "--wait", "30"));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${url}\n`);
    assert.ok(Date.now() - started < 20000);
  });
});

describe("second démarrage (intégration, sous-processus)", () => {
  test("affiche l'URL existante, sort avec 0 et ne lance pas de second serveur", async () => {
    const { repo, fake, proc, port, url } = await runningServer();
    const appelsGh = fake.calls().length;
    const lockAvant = fs.readFileSync(repo.lockFile, "utf8");

    const second = await runVizCli(["--project", repo.dir, "--public-dir", PUBLIC_REL], { fake });
    assert.equal(second.code, 0);
    assert.equal(second.stdout, `${url}\n`);
    assert.match(second.stderr, /\[gepet-squad-viz\] info Un serveur est déjà lancé pour ce projet \(pid \d+, port \d+\)\. Aucun second serveur n'est démarré\./);
    assert.ok(!second.stderr.includes(" error "));

    // Un seul serveur : même verrou, même processus, aucun nouvel appel à gh, le premier répond toujours.
    assert.equal(fs.readFileSync(repo.lockFile, "utf8"), lockAvant);
    assert.equal(readLockFile(repo).pid, proc.child.pid);
    assert.equal(fake.calls().length, appelsGh, "le second démarrage ne prend pas d'instantané GitHub");
    assert.ok(isPidAlive(proc.child.pid));
    assert.equal(await healthStatus(port), 200);
  });

  test("la sous-commande start explicite se comporte de la même façon", async () => {
    const { repo, url } = await runningServer();
    const second = await runVizCli(["start", "--project", repo.dir, "--port", "0"]);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, `${url}\n`);
  });

  test("deux démarrages simultanés : un seul serveur reste, l'autre affiche son URL et sort avec 0", async () => {
    const repo = squadRepo();
    const fake = fakeGh();
    const a = startVizProcess({ project: repo.dir, fake });
    const b = startVizProcess({ project: repo.dir, fake });
    for (const proc of [a, b]) cleanups.push(() => proc.child.kill("SIGKILL"));

    const premier = await Promise.race([a.exited.then((r) => ({ proc: a, other: b, ...r })), b.exited.then((r) => ({ proc: b, other: a, ...r }))]);
    assert.equal(premier.code, 0, premier.proc.stderr());
    const port = await premier.other.ready;
    assert.equal(premier.proc.stdout(), `http://127.0.0.1:${port}\n`);
    assert.equal(readLockFile(repo).pid, premier.other.child.pid);
    assert.equal(await healthStatus(port), 200);
  });
});

describe("stop (intégration, sous-processus)", () => {
  test("arrête le serveur, attend sa fin, supprime le verrou et sort avec 0", async () => {
    const { repo, proc, port } = await runningServer();
    const pid = proc.child.pid;
    assert.ok(fs.existsSync(repo.lockFile));

    const result = await runVizCli(projectArgs(repo, "stop"));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`info Serveur arrêté \\(pid ${pid}, port ${port}\\)`));
    assert.equal(result.stdout, "");

    // Au retour de `stop`, le processus a déjà fini et le verrou a disparu (Windows compris : c'est `stop` qui le supprime).
    assert.equal(isPidAlive(pid), false, "le processus du serveur doit être terminé");
    assert.ok(!fs.existsSync(repo.lockFile), "le verrou doit être supprimé");
    await proc.exited;
    await assert.rejects(httpGet(port, "/health"), { code: "ECONNREFUSED" });
  });

  test("après stop, status répond « aucun serveur » et un nouveau serveur peut démarrer", async () => {
    const { repo, fake } = await runningServer();
    assert.equal((await runVizCli(projectArgs(repo, "stop"))).code, 0);
    assert.equal((await runVizCli(projectArgs(repo, "status"))).code, 1);

    const again = await runningServer(repo, fake);
    assert.equal(readLockFile(repo).pid, again.proc.child.pid);
    assert.equal((await runVizCli(projectArgs(repo, "stop"))).code, 0);
  });

  test("sans serveur vivant : code 1 et message clair", async () => {
    const repo = squadRepo();
    const result = await runVizCli(projectArgs(repo, "stop"));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /\[gepet-squad-viz\] error Aucun serveur lancé pour ce projet\./);
  });

  test("verrou périmé (pid inexistant) : code 1 et verrou nettoyé", async () => {
    const repo = squadRepo();
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port: 4321, pid: deadPid() }));
    const result = await runVizCli(projectArgs(repo, "stop"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /warn Verrou périmé supprimé/);
    assert.match(result.stderr, /error Aucun serveur lancé/);
    assert.ok(!fs.existsSync(repo.lockFile));
  });

  test("n'arrête pas un processus étranger dont le pid figure dans un verrou périmé (le port ne répond pas)", async () => {
    const repo = squadRepo();
    const other = bystander();
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port: await freePort(), pid: other.pid }));

    const result = await runVizCli(projectArgs(repo, "stop"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`warn Verrou périmé supprimé .*: le processus ${other.pid} existe, mais le port \\d+ ne répond pas comme son serveur`));
    assert.match(result.stderr, new RegExp(`Aucun signal n'a été envoyé au processus ${other.pid}`));
    assert.ok(result.stderr.includes(repo.lockFile), "le message indique le fichier de verrou");
    assert.match(result.stderr, /error Aucun serveur lancé/);
    assert.equal(isPidAlive(other.pid), true, "le processus étranger doit rester vivant");
    assert.ok(!fs.existsSync(repo.lockFile), "le verrou périmé est nettoyé");
  });

  test("n'arrête pas non plus un processus dont le port répond par autre chose qu'un serveur de visualisation", async () => {
    const repo = squadRepo();
    const other = bystander();
    const impostor = await fakeHealthServer("bonjour");
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port: impostor.port, pid: other.pid }));

    const result = await runVizCli(projectArgs(repo, "stop"));
    assert.equal(result.code, 1);
    assert.equal(isPidAlive(other.pid), true);
    assert.ok(!fs.existsSync(repo.lockFile));
  });
});

/** Faux serveur HTTP sur 127.0.0.1 qui répond `body` (texte ou objet JSON) à toute requête et mémorise les requêtes. */
async function fakeHealthServer(body, { status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: server.address().port, requests };
}

describe("pid vivant mais étranger au serveur : une seule définition de « vivant » (intégration, sous-processus)", () => {
  // Cas du redémarrage de la machine : le verrou désigne un pid réattribué à un autre processus (ici `bystander`,
  // vivant), et un port muet, tenu par un faux serveur de /health, ou tenu par un vrai serveur d'un autre pid.
  const impostures = [
    { nom: "faux serveur {ok: true} sans pid", prepare: () => fakeHealthServer({ ok: true }) },
    { nom: "faux serveur {ok: true} avec le pid d'un autre processus", prepare: () => fakeHealthServer({ ok: true, pid: 1 }) },
    { nom: "faux serveur dont le pid est une chaîne", prepare: (other) => fakeHealthServer({ ok: true, pid: String(other.pid) }) },
    { nom: "faux serveur dont le corps dépasse 1 Ko", prepare: (other) => fakeHealthServer({ ok: true, pid: other.pid, padding: "x".repeat(2000) }) },
    { nom: "port muet (rien n'écoute)", prepare: async () => ({ port: await freePort(), requests: [] }) },
  ];

  /** Verrou {port, pid: processus étranger vivant} où `port` est celui de l'imposture. */
  async function lockedByImpostor(imposture) {
    const repo = squadRepo();
    const other = bystander();
    const fake = await imposture.prepare(other);
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port: fake.port, pid: other.pid }));
    return { repo, other, fake };
  }

  for (const imposture of impostures) {
    test(`status : ${imposture.nom} -> aucune URL, code 1, verrou supprimé`, async () => {
      const { repo, other, fake } = await lockedByImpostor(imposture);
      const result = await runVizCli(projectArgs(repo, "status"));
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "", "aucune URL morte n'est affichée");
      assert.match(result.stderr, new RegExp(`warn Verrou périmé supprimé .*: le processus ${other.pid} existe, mais le port ${fake.port} ne répond pas`));
      assert.ok(!fs.existsSync(repo.lockFile));
      assert.equal(isPidAlive(other.pid), true);
      for (const request of fake.requests) assert.equal(request, "GET /health", "seul GET /health est émis");
    });

    test(`stop : ${imposture.nom} -> aucun signal, code 1, verrou nettoyé`, async () => {
      const { repo, other, fake } = await lockedByImpostor(imposture);
      const result = await runVizCli(projectArgs(repo, "stop"));
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Aucun signal n'a été envoyé/);
      assert.equal(isPidAlive(other.pid), true, "le processus désigné par le verrou n'a reçu aucun signal");
      assert.ok(!fs.existsSync(repo.lockFile));
      for (const request of fake.requests) assert.equal(request, "GET /health");
    });

    test(`démarrage : ${imposture.nom} -> le verrou périmé est remplacé et un serveur démarre`, async () => {
      const { repo, other } = await lockedByImpostor(imposture);
      const proc = startVizProcess({ project: repo.dir, fake: fakeGh() });
      cleanups.push(() => proc.child.kill("SIGKILL"));
      const port = await proc.ready;
      assert.deepEqual(readLockFile(repo), { port, pid: proc.child.pid });
      assert.equal(isPidAlive(other.pid), true);
      assert.equal(proc.stdout(), "", "ce n'est pas le cas « déjà lancé » : rien sur stdout");
    });
  }

  test("status --wait : un pid étranger vivant ne donne jamais d'URL ; code 1 après le délai", async () => {
    const { repo } = await lockedByImpostor(impostures[0]);
    const started = Date.now();
    const result = await runVizCli(projectArgs(repo, "status", "--wait", "1"));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Aucun serveur lancé pour ce projet \(attendu 1 s\)\./);
    assert.ok(Date.now() - started >= 900);
    assert.ok(!fs.existsSync(repo.lockFile));
  });

  test("un vrai serveur dont le pid n'est pas celui du verrou (pid réattribué, port réutilisé) n'est pas considéré vivant", async () => {
    const { repo, proc, port } = await runningServer();
    const other = bystander();
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port, pid: other.pid })); // le pid du verrou n'est pas celui du serveur
    const result = await runVizCli(projectArgs(repo, "stop"));
    assert.equal(result.code, 1);
    assert.equal(isPidAlive(other.pid), true, "le processus étranger n'a reçu aucun signal");
    assert.equal(isPidAlive(proc.child.pid), true, "le vrai serveur n'a pas été arrêté non plus");
    assert.equal(await healthStatus(port), 200);
    assert.ok(!fs.existsSync(repo.lockFile));
  });

  test("témoin : si /health annonce bien le pid du verrou, le serveur est vivant (status, démarrage, puis stop envoie le signal)", async () => {
    const repo = squadRepo();
    const other = bystander();
    // Un faux serveur qui annonce le bon pid est indiscernable d'un vrai : c'est la définition, pas une authentification.
    const honest = await fakeHealthServer({ ok: true, pid: other.pid });
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port: honest.port, pid: other.pid }));

    const status = await runVizCli(projectArgs(repo, "status"));
    assert.equal(status.code, 0);
    assert.equal(status.stdout, `http://127.0.0.1:${honest.port}\n`);

    const start = await runVizCli(["--project", repo.dir, "--public-dir", PUBLIC_REL], { fake: fakeGh() });
    assert.equal(start.code, 0);
    assert.equal(start.stdout, `http://127.0.0.1:${honest.port}\n`);
    assert.match(start.stderr, /Aucun second serveur n'est démarré/);
    assert.equal(readLockFile(repo).pid, other.pid, "le verrou n'a pas été remplacé");

    const stop = await runVizCli(projectArgs(repo, "stop"));
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(isPidAlive(other.pid), false, "le signal part bien quand le pid est confirmé par /health");
    assert.ok(!fs.existsSync(repo.lockFile));
  });
});

describe("verrou invalide ou hostile (intégration, sous-processus)", () => {
  // `dead` : pid d'un processus terminé. Les deux derniers verrous sont invalides (port) ou périmés (pid), jamais vivants.
  const contenus = (dead) => [
    "{ pas du json",
    "",
    '{"pid":"$(touch pwned)","port":"x"}',
    '{"pid":"12; touch pwned","port":4321}',
    '{"pid":0,"port":4321}',
    `{"pid":${dead},"port":"evil.example:80"}`,
    `{"pid":${dead},"port":4321,"cmd":"touch pwned","url":"http://evil.example"}`,
  ];

  test("status et stop traitent un verrou invalide comme périmé : code 1, verrou supprimé, rien d'exécuté", async () => {
    for (const contenu of contenus(deadPid())) {
      for (const commande of ["status", "stop"]) {
        const repo = squadRepo();
        fs.writeFileSync(repo.lockFile, contenu);
        const result = await runVizCli(projectArgs(repo, commande), { cwd: repo.dir });
        assert.equal(result.code, 1, `${commande} ${contenu}`);
        assert.equal(result.stdout, "", `${commande} ${contenu}`);
        assert.ok(!fs.existsSync(repo.lockFile), `${commande} ${contenu}`);
        assert.ok(!fs.existsSync(path.join(repo.dir, "pwned")), "aucune valeur du verrou ne doit être exécutée");
      }
    }
  });

  test("status n'affiche que l'URL reconstruite à partir du port, jamais un autre champ du verrou", async () => {
    const repo = squadRepo();
    const other = bystander();
    const health = await fakeHealthServer({ ok: true, pid: other.pid });
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port: health.port, pid: other.pid, url: "http://evil.example", host: "evil.example" }));
    const result = await runVizCli(projectArgs(repo, "status"));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `http://127.0.0.1:${health.port}\n`);
  });
});

function httpGet(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}

const healthStatus = (port) => httpGet(port, "/health");
