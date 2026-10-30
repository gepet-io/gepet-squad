// Tests de viz/server.cjs : fonctions de la CLI et du verrou (unitaires), puis le serveur démarré en sous-processus
// (`node viz/server.cjs`) sur un port éphémère, avec le faux `gh`, un repo git temporaire et un journal de fixture.
// Les protections de l'ADR 0005 sont vérifiées par de vraies requêtes HTTP.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const server = require("../../viz/server.cjs");
const { createTempRepo, gitCommonDir, installFakeGh } = require("../helpers/index.cjs");

const { StartupError, parseCli, parseJournal, warningFromError, isPidAlive, acquireLock, releaseLock, startServer } = server;
const { GhError } = require("../../viz/lib/github.cjs");

const REPO_ROOT = path.join(__dirname, "..", "..");
const SERVER_CJS = path.join(REPO_ROOT, "viz", "server.cjs");
const PRELOAD = path.join(__dirname, "..", "helpers", "gh-preload.cjs");
const GH_FIXTURES = path.join(__dirname, "..", "fixtures", "gh-json");
const PUBLIC_REL = "tests/fixtures/public/";
const PUBLIC_DIR = path.join(REPO_ROOT, "tests", "fixtures", "public");
const SESSION = "5f3c1a9e-7b2d-4c6e-9a41-0d8e2b7f6c13";

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(GH_FIXTURES, name), "utf8"));

function fixtureRoutes() {
  return [
    { match: ["api", "-X", "GET", "repos/o/r/milestones"], json: fixture("milestones.json") },
    { match: ["issue", "list", "--repo", "o/r"], json: fixture("issues.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "open"], json: fixture("pulls-open.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "develop"], json: fixture("pulls-merged-develop.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "main"], json: fixture("pulls-merged-main.json") },
  ];
}

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
const jsonl = (events) => events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n") + "\n";

// Journal de fixture : l'ancien fichier (rotation) puis le courant, avec une ligne illisible entre les deux événements.
const ROTATED_EVENTS = [
  {
    v: 1, ts: ago(300), src: "hook", type: "agent.requested", sessionId: SESSION,
    toolUseId: "toolu_dev", agentType: "claude-gepet-squad:developpeur", mode: "IMPLEMENTATION", issue: 12,
  },
];
const CURRENT_EVENTS = [
  { v: 1, ts: ago(290), src: "hook", type: "agent.launched", sessionId: SESSION, toolUseId: "toolu_dev", agentId: "agent-dev1", agentType: "claude-gepet-squad:developpeur" },
  "ceci n'est pas du JSON",
  { v: 1, ts: ago(280), src: "hook", type: "agent.started", sessionId: SESSION, agentId: "dev1", agentType: "claude-gepet-squad:developpeur" },
  {
    v: 1, ts: ago(60), src: "hook", type: "agent.requested", sessionId: SESSION,
    toolUseId: "toolu_ver", agentType: "claude-gepet-squad:verificateur", issue: 3, pr: 40,
  },
];

/** Repo git temporaire avec .gepet-squad.json et, au choix, le journal de fixture. */
function squadRepo({ config = { version: 1, repo: "o/r" }, rawConfig, journal = true } = {}) {
  const repo = createTempRepo();
  cleanups.push(repo.cleanup);
  fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), rawConfig !== undefined ? rawConfig : JSON.stringify(config));
  const common = gitCommonDir(repo.dir);
  const journalDir = path.join(common, "gepet-squad");
  fs.mkdirSync(journalDir, { recursive: true });
  if (journal) {
    fs.writeFileSync(path.join(journalDir, "events.1.jsonl"), jsonl(ROTATED_EVENTS));
    fs.writeFileSync(path.join(journalDir, "events.jsonl"), jsonl(CURRENT_EVENTS));
  }
  return { ...repo, common, journalDir, lockFile: path.join(journalDir, "viz.lock") };
}

function fakeGh(routes) {
  const fake = installFakeGh({ routes });
  cleanups.push(fake.cleanup);
  return fake;
}

/**
 * Lance `node viz/server.cjs` et attend la ligne d'information sur stderr.
 * Sous Windows, le faux gh (un .cmd) est branché par un module préchargé (voir gh-preload.cjs) ;
 * ailleurs `gh` est trouvé dans le PATH, comme en production.
 */
function startProcess({ project, fake, extraArgs = [], publicArg = PUBLIC_REL, cwd = REPO_ROOT }) {
  const env = fake ? fake.env() : { ...process.env };
  const execArgv = [];
  if (fake && process.platform === "win32") {
    env.GEPET_TEST_FAKE_GH_SCRIPT = path.join(fake.dir, "fake-gh.cjs");
    execArgv.push("--require", PRELOAD);
  }
  const args = [...execArgv, SERVER_CJS, "--project", project];
  if (publicArg) args.push("--public-dir", publicArg);
  args.push(...extraArgs);

  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  cleanups.push(() => child.kill("SIGKILL"));

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serveur non prêt après 15 s. stderr :\n${stderr}`)), 15000);
    const check = () => {
      const match = /\[gepet-squad-viz\] info http:\/\/127\.0\.0\.1:(\d+)\n/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stderr.on("data", check);
    exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`serveur arrêté (code ${code}) avant d'être prêt. stderr :\n${stderr}`));
    });
  });
  // Évite un rejet non géré si le test attend `exited` à la place de `ready`.
  ready.catch(() => {});
  return { child, exited, ready, stderr: () => stderr, stdout: () => stdout };
}

/** Requête HTTP brute : le chemin et le Host sont envoyés tels quels (aucune normalisation). */
function request(port, target, { method = "GET", headers = {}, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method, agent: false, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function runningServer(options = {}) {
  const repo = options.repo || squadRepo();
  const fake = options.fake || fakeGh(fixtureRoutes());
  const proc = startProcess({ project: repo.dir, fake, ...options.process });
  const port = await proc.ready;
  return { repo, fake, proc, port, get: (target, opts) => request(port, target, opts) };
}

function importmapHashOf(html) {
  const open = '<script type="importmap">';
  const start = html.indexOf(open) + open.length;
  const text = html.slice(start, html.indexOf("</script>", start));
  return "sha256-" + crypto.createHash("sha256").update(text).digest("base64");
}

// ---------------------------------------------------------------------------------------------------------------
// Unitaires
// ---------------------------------------------------------------------------------------------------------------

describe("parseCli (unitaire)", () => {
  const CWD = path.resolve("dossier-courant");

  test("valeurs par défaut : projet courant, port 0, viz/public", () => {
    const options = parseCli([], CWD);
    assert.equal(options.help, false);
    assert.equal(options.project, CWD);
    assert.equal(options.port, 0);
    assert.equal(options.publicDir, path.join(REPO_ROOT, "viz", "public"));
  });

  test("--project, --port et --public-dir, chemins relatifs résolus depuis le dossier courant", () => {
    const options = parseCli(["--project", "projet", "--port", "4321", "--public-dir", "tests/fixtures/public/"], CWD);
    assert.equal(options.project, path.join(CWD, "projet"));
    assert.equal(options.port, 4321);
    assert.equal(options.publicDir, path.join(CWD, "tests", "fixtures", "public"));
  });

  test("--port 0 est accepté, et --help demande l'aide", () => {
    assert.equal(parseCli(["--port", "0"], CWD).port, 0);
    assert.equal(parseCli(["--port", "65535"], CWD).port, 65535);
    assert.deepEqual(parseCli(["--help"], CWD), { help: true });
    assert.deepEqual(parseCli(["-h"], CWD), { help: true });
  });

  test("un port invalide, une option inconnue ou un argument en trop donnent une erreur de code 2", () => {
    const invalides = [["--port", "65536"], ["--port", "-1"], ["--port", "abc"], ["--port", "1.5"], ["--port", ""], ["--hote", "0.0.0.0"], ["status"], ["stop", "--project", "x"], ["--project"]];
    for (const argv of invalides) {
      assert.throws(() => parseCli(argv, CWD), (error) => error instanceof StartupError && error.exitCode === 2, argv.join(" "));
    }
  });

  test("aucune option ne permet de choisir l'adresse d'écoute ni le binaire gh", () => {
    for (const option of ["--host", "--bind", "--gh", "--gh-bin", "--exec-file"]) {
      assert.throws(() => parseCli([option, "valeur"], CWD), StartupError, option);
    }
  });
});

describe("parseJournal (unitaire)", () => {
  test("lit les objets JSON, ignore les lignes vides et compte les lignes invalides", () => {
    const text = '{"type":"a"}\n\n   \n{"type":"b"}\r\nn\'importe quoi\n[1,2]\n"texte"\nnull\n{"type":"c"}';
    const { events, skipped } = parseJournal(text);
    assert.deepEqual(events, [{ type: "a" }, { type: "b" }, { type: "c" }]);
    assert.equal(skipped, 4);
  });

  test("texte vide : rien", () => {
    assert.deepEqual(parseJournal(""), { events: [], skipped: 0 });
  });
});

describe("warningFromError (unitaire)", () => {
  const AT = "2026-10-30T12:00:00.000Z";

  test("reprend code et message d'une GhError, jamais detail", () => {
    const error = new GhError("GH_AUTH", "gh a échoué (code 4).", "SECRET stderr brut /home/moi/chemin");
    const warning = warningFromError(error, AT);
    assert.deepEqual(warning, { code: "GH_AUTH", message: "gh a échoué (code 4).", at: AT });
    assert.ok(!JSON.stringify(warning).includes("SECRET"));
  });

  test("une erreur inattendue devient un GH_PARSE générique, sans son message", () => {
    const warning = warningFromError(new Error("chemin C:\\Users\\moi\\secret"), AT);
    assert.equal(warning.code, "GH_PARSE");
    assert.ok(!warning.message.includes("secret"));
    assert.deepEqual(warningFromError("texte", AT).code, "GH_PARSE");
  });
});

describe("verrou viz.lock (unitaire)", () => {
  function tempLock() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-lock-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, "sous-dossier", "viz.lock");
  }
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

  test("crée le dossier et écrit {port, pid}", () => {
    const lockFile = tempLock();
    acquireLock(lockFile, 4321);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, "utf8")), { port: 4321, pid: process.pid });
  });

  test("refuse de remplacer le verrou d'un processus vivant", () => {
    const lockFile = tempLock();
    acquireLock(lockFile, 1111);
    assert.throws(() => acquireLock(lockFile, 2222), (error) => error instanceof StartupError && /déjà lancé/.test(error.message) && error.message.includes("1111"));
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).port, 1111);
  });

  test("remplace un verrou dont le pid n'existe plus, ou illisible", () => {
    const lockFile = tempLock();
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ port: 1, pid: deadPid() }));
    acquireLock(lockFile, 2222);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, "utf8")), { port: 2222, pid: process.pid });

    fs.writeFileSync(lockFile, "{ pas du json");
    acquireLock(lockFile, 3333);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).port, 3333);
  });

  test("releaseLock ne supprime que le verrou de ce processus", () => {
    const lockFile = tempLock();
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ port: 1, pid: process.pid + 1 }));
    releaseLock(lockFile);
    assert.ok(fs.existsSync(lockFile), "le verrou d'un autre processus reste");
    fs.writeFileSync(lockFile, JSON.stringify({ port: 1, pid: process.pid }));
    releaseLock(lockFile);
    assert.ok(!fs.existsSync(lockFile));
    releaseLock(lockFile); // absent : sans effet
  });

  test("isPidAlive", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(deadPid()), false);
    for (const pid of [0, -5, 1.5, "12", null, undefined]) assert.equal(isPidAlive(pid), false, String(pid));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Intégration : démarrage dans le processus de test (cycle de vie du verrou sur toutes les plateformes)
// ---------------------------------------------------------------------------------------------------------------

describe("startServer dans le processus (intégration)", () => {
  test("écrit viz.lock au démarrage et le supprime à la fermeture, sans appel à gh", async () => {
    // Repo invalide : GH_REPO est refusé avant tout appel à gh, donc ce test ne dépend d'aucun gh.
    const repo = squadRepo({ config: { version: 1, repo: "pas un repo" } });
    const running = await startServer({ project: repo.dir, port: 0, publicDir: PUBLIC_DIR });
    let closed = false;
    cleanups.push(() => {
      if (!closed) running.close();
    });

    assert.equal(running.lockFile, repo.lockFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(repo.lockFile, "utf8")), { port: running.port, pid: process.pid });
    assert.equal(running.url, `http://127.0.0.1:${running.port}`);

    const health = await request(running.port, "/health");
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    const state = JSON.parse((await request(running.port, "/state")).body);
    assert.ok(state.warnings.some((w) => w.code === "GH_REPO"), JSON.stringify(state.warnings));
    assert.ok(state.warnings.some((w) => w.code === "SNAPSHOT_MISSING"));

    await running.close();
    closed = true;
    assert.ok(!fs.existsSync(repo.lockFile), "le verrou doit être supprimé");
    await assert.rejects(request(running.port, "/health"), { code: "ECONNREFUSED" });
  });

  test("sans .gepet-squad.json : StartupError claire, sans écouter ni écrire de verrou", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-sansconfig-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    await assert.rejects(
      startServer({ project: dir, port: 0, publicDir: PUBLIC_DIR }),
      (error) => error instanceof StartupError && /\.gepet-squad\.json introuvable/.test(error.message),
    );
  });

  test("un port déjà utilisé donne une erreur claire et ne laisse aucun verrou", async () => {
    const occupant = net.createServer();
    await new Promise((resolve) => occupant.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => occupant.close());
    const repo = squadRepo({ config: { version: 1, repo: "pas un repo" } });
    await assert.rejects(
      startServer({ project: repo.dir, port: occupant.address().port, publicDir: PUBLIC_DIR }),
      (error) => error instanceof StartupError && /déjà utilisé/.test(error.message),
    );
    assert.ok(!fs.existsSync(repo.lockFile));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Intégration : serveur en sous-processus
// ---------------------------------------------------------------------------------------------------------------

describe("démarrage du serveur (intégration, sous-processus)", () => {
  test("affiche l'URL sur stderr, écrit viz.lock {port, pid}, et rien sur stdout", async () => {
    const { repo, proc, port } = await runningServer();

    assert.match(proc.stderr(), new RegExp(`^\\[gepet-squad-viz\\] info http://127\\.0\\.0\\.1:${port}\\n`, "m"));
    assert.ok(port > 0 && port < 65536);
    assert.deepEqual(JSON.parse(fs.readFileSync(repo.lockFile, "utf8")), { port, pid: proc.child.pid });
    assert.equal(proc.stdout(), "", "rien sur stdout");
  });

  test("le journal d'événements est dans le dossier commun de git, au même endroit que le collecteur", async () => {
    const { repo } = await runningServer();
    assert.equal(path.dirname(repo.lockFile), path.join(gitCommonDir(repo.dir), "gepet-squad"));
  });

  test("n'écoute que sur 127.0.0.1 : refus sur les autres adresses de la machine", async () => {
    const { port } = await runningServer();
    const candidates = ["::1"];
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const a of addresses || []) if (a.family === "IPv4" && !a.internal) candidates.push(a.address);
    }
    for (const host of candidates) {
      const outcome = await new Promise((resolve) => {
        const socket = net.connect({ host, port });
        socket.setTimeout(2000);
        socket.once("connect", () => {
          socket.destroy();
          resolve("connecté");
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve("délai");
        });
        socket.once("error", (error) => resolve(error.code));
      });
      assert.notEqual(outcome, "connecté", `le serveur ne doit pas répondre sur ${host}`);
    }
  });

  test("--port fixe le port, et un second serveur sur le même projet est refusé", async () => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const wanted = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const first = await runningServer({ process: { extraArgs: ["--port", String(wanted)] } });
    assert.equal(first.port, wanted);
    assert.equal(JSON.parse(fs.readFileSync(first.repo.lockFile, "utf8")).port, wanted);

    const second = startProcess({ project: first.repo.dir, fake: first.fake });
    const { code } = await second.exited;
    assert.notEqual(code, 0);
    assert.match(second.stderr(), /\[gepet-squad-viz\] error Un serveur est déjà lancé/);
    assert.equal(JSON.parse(fs.readFileSync(first.repo.lockFile, "utf8")).pid, first.proc.child.pid, "le verrou du premier est intact");
    assert.equal((await first.get("/health")).status, 200, "le premier serveur répond toujours");
  });

  test("un verrou périmé (pid inexistant) est ignoré au démarrage", async () => {
    const repo = squadRepo();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.writeFileSync(repo.lockFile, JSON.stringify({ port: 9, pid: dead }));
    const { proc, port } = await runningServer({ repo });
    assert.deepEqual(JSON.parse(fs.readFileSync(repo.lockFile, "utf8")), { port, pid: proc.child.pid });
  });

  test("sans .gepet-squad.json : sortie non nulle, message clair, aucun serveur", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-sansconfig-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const proc = startProcess({ project: dir });
    const { code } = await proc.exited;
    assert.notEqual(code, 0);
    assert.match(proc.stderr(), /\[gepet-squad-viz\] error \.gepet-squad\.json introuvable/);
    assert.ok(!proc.stderr().includes(" info http://"));
  });

  test("options invalides : code de sortie 2 et usage", async () => {
    const repo = squadRepo();
    const proc = startProcess({ project: repo.dir, extraArgs: ["--port", "99999"] });
    const { code } = await proc.exited;
    assert.equal(code, 2);
    assert.match(proc.stderr(), /--port doit être un entier/);
  });
});

describe("/health, /state et fichiers statiques (intégration, sous-processus)", () => {
  test("/health renvoie {ok: true}", async () => {
    const { get } = await runningServer();
    const res = await get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  });

  test("/state fusionne l'instantané (faux gh) et le journal complet (fichier tournant compris)", async () => {
    const { get, fake } = await runningServer();
    const res = await get("/state");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-store");
    const state = JSON.parse(res.body);

    assert.equal(state.repo, "o/r");
    assert.ok(!Number.isNaN(Date.parse(state.updatedAt)));
    assert.deepEqual(state.warnings, []);
    assert.deepEqual(state.milestones.map((m) => m.number), [1, 2]);
    assert.deepEqual(state.features.map((f) => f.number), [3, 12]);
    const dev = state.features.find((f) => f.number === 12);
    assert.equal(dev.status, "in-progress");
    assert.equal(dev.retry, 2);
    assert.equal(dev.station, "dev");
    assert.equal(dev.milestone, "M2 — Serveur temps réel");
    assert.deepEqual(state.releases.map((r) => [r.branch, r.state]), [["release/m0-socle", "merged"], ["release/m1-collecte", "open"]]);

    // Un agent vient de events.1.jsonl (requested) + events.jsonl (launched, started), l'autre de events.jsonl.
    assert.deepEqual(state.agents.map((a) => [a.type, a.issue]), [["developpeur", 12], ["verificateur", 3]]);
    const developpeur = state.agents[0];
    assert.equal(developpeur.agentId, "dev1");
    assert.equal(developpeur.phase, "running");
    assert.equal(state.agents[1].phase, "requested");

    // Un seul instantané au démarrage : 5 appels gh, aucun par requête.
    assert.equal(fake.calls().length, 5);
    await get("/state");
    assert.equal(fake.calls().length, 5);
  });

  test("/state recalcule l'horloge à chaque requête", async () => {
    const { get } = await runningServer();
    const first = JSON.parse((await get("/state")).body).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = JSON.parse((await get("/state")).body).updatedAt;
    assert.ok(Date.parse(second) > Date.parse(first));
  });

  test("sert index.html, les scripts et les styles depuis --public-dir, avec le bon type MIME", async () => {
    const { get } = await runningServer();
    const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

    const root = await get("/");
    assert.equal(root.status, 200);
    assert.equal(root.body, html);
    assert.equal(root.headers["content-type"], "text/html; charset=utf-8");
    assert.equal((await get("/index.html")).body, html);

    const js = await get("/js/app.js");
    assert.equal(js.status, 200);
    assert.equal(js.body, fs.readFileSync(path.join(PUBLIC_DIR, "js", "app.js"), "utf8"));
    assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(js.headers["content-length"], String(Buffer.byteLength(js.body)));

    const css = await get("/css/app.css?v=2");
    assert.equal(css.status, 200);
    assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
  });

  test("HEAD renvoie les en-têtes sans corps", async () => {
    const { get } = await runningServer();
    const head = await get("/js/app.js", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], (await get("/js/app.js")).headers["content-length"]);
    assert.equal((await get("/state", { method: "HEAD" })).status, 200);
    assert.equal((await get("/health", { method: "HEAD" })).body, "");
  });

  test("le dossier public par défaut peut être absent : le serveur démarre quand même", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-public-vide-"));
    cleanups.push(() => fs.rmSync(empty, { recursive: true, force: true }));
    const { get, proc } = await runningServer({ process: { publicArg: empty } });
    assert.equal((await get("/")).status, 404);
    assert.equal((await get("/health")).status, 200);
    assert.match(proc.stderr(), /warn index\.html illisible/);
    assert.ok(!(await get("/health")).headers["content-security-policy"].includes("sha256"));
  });
});

describe("protections de l'ADR 0005 (intégration, sous-processus)", () => {
  test("Host étranger, absent de port ou d'un autre port : 421, pour toutes les routes", async () => {
    const { get, port } = await runningServer();
    const hotes = ["evil.example", `evil.example:${port}`, "127.0.0.1", "localhost", `127.0.0.1:${port + 1}`, `localhost:${port + 1}`, `[::1]:${port}`, `127.0.0.1.evil.example:${port}`, `0.0.0.0:${port}`];
    for (const host of hotes) {
      for (const target of ["/", "/state", "/health", "/js/app.js", "/inconnu.html"]) {
        const res = await get(target, { host });
        assert.equal(res.status, 421, `${host} ${target}`);
        assert.ok(!res.body.includes("fixture"), "aucun contenu n'est servi à un hôte étranger");
        assert.ok(!res.body.includes('"repo"'));
      }
    }
  });

  test("127.0.0.1:<port> et localhost:<port> sont acceptés", async () => {
    const { get, port } = await runningServer();
    assert.equal((await get("/health", { host: `127.0.0.1:${port}` })).status, 200);
    assert.equal((await get("/health", { host: `localhost:${port}` })).status, 200);
    assert.equal((await get("/state", { host: `LOCALHOST:${port}` })).status, 200);
  });

  test("toute méthode autre que GET et HEAD : 405 avec Allow", async () => {
    const { get } = await runningServer();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
      for (const target of ["/state", "/health", "/", "/js/app.js"]) {
        const res = await get(target, { method });
        assert.equal(res.status, 405, `${method} ${target}`);
        assert.equal(res.headers.allow, "GET, HEAD");
      }
    }
  });

  test("traversée de chemin, y compris encodée : 403, jamais le contenu du fichier visé", async () => {
    const { get } = await runningServer();
    const secret = fs.readFileSync(path.join(GH_FIXTURES, "issues.json"), "utf8");
    const marqueur = "Récupérer l'instantané GitHub";
    assert.ok(secret.includes(marqueur));

    const cibles = [
      "/../gh-json/issues.json",
      "/../../fixtures/gh-json/issues.json",
      "/js/../../gh-json/issues.json",
      "/..%2fgh-json%2fissues.json",
      "/..%2Fgh-json%2Fissues.json",
      "/%2e%2e/gh-json/issues.json",
      "/%2E%2E/gh-json/issues.json",
      "/%2e%2e%2fgh-json%2fissues.json",
      "/js/%2e%2e/%2e%2e/gh-json/issues.json",
      "/js/..%2f..%2fgh-json%2fissues.json",
      "/.%2e/gh-json/issues.json",
      "//../gh-json/issues.json",
      "/..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd",
    ];
    for (const cible of cibles) {
      const res = await get(cible);
      assert.equal(res.status, 403, cible);
      assert.ok(!res.body.includes(marqueur), cible);
    }
    // Avec des antislashs : une traversée sous Windows, un simple nom de fichier ailleurs. Jamais le fichier visé.
    for (const cible of ["/..%5cgh-json%5cissues.json", "/js/..\\..\\gh-json\\issues.json"]) {
      const res = await get(cible);
      assert.equal(res.status, process.platform === "win32" ? 403 : 404, cible);
      assert.ok(!res.body.includes(marqueur), cible);
    }
  });

  test("octet nul : 403 ; pourcentage mal formé : 400", async () => {
    const { get } = await runningServer();
    assert.equal((await get("/index.html%00.png")).status, 403);
    assert.equal((await get("/%zz")).status, 400);
  });

  test("fichier absent, extension hors liste blanche, dossier, route non gérée : 404", async () => {
    const { get } = await runningServer();
    for (const cible of ["/absent.html", "/js/absent.js", "/notes.txt", "/README.md", "/js", "/js/", "/events", "/state/", "/%252e%252e/index.html"]) {
      const res = await get(cible);
      assert.equal(res.status, 404, cible);
      assert.ok(!res.body.includes("fixture"), cible);
    }
  });

  test("la forme absolue de la cible est refusée (400)", async () => {
    const { get } = await runningServer();
    assert.equal((await get("http://evil.example/index.html")).status, 400);
  });

  test("aucun en-tête CORS, même avec un Origin", async () => {
    const { get } = await runningServer();
    const reponses = [
      await get("/state", { headers: { Origin: "https://evil.example" } }),
      await get("/", { headers: { Origin: "https://evil.example" } }),
      await get("/state", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } }),
      await get("/state", { host: "evil.example", headers: { Origin: "https://evil.example" } }),
    ];
    for (const res of reponses) {
      for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith("access-control-"), `${res.status} ${name}`);
    }
  });

  test("CSP avec l'empreinte de l'importmap, nosniff et no-referrer sur chaque réponse", async () => {
    const { get, port } = await runningServer();
    const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
    const hash = importmapHashOf(html);
    const csp =
      `default-src 'self'; script-src 'self' '${hash}'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`;

    const reponses = {
      "200 index": await get("/"),
      "200 js": await get("/js/app.js"),
      "200 state": await get("/state"),
      "200 health": await get("/health"),
      "200 head": await get("/", { method: "HEAD" }),
      "404": await get("/absent.html"),
      "403": await get("/..%2fgh-json%2fissues.json"),
      "400": await get("/%zz"),
      "405": await get("/state", { method: "POST" }),
      "421": await get("/state", { host: `evil.example:${port}` }),
    };
    for (const [nom, res] of Object.entries(reponses)) {
      assert.equal(res.headers["content-security-policy"], csp, nom);
      assert.equal(res.headers["x-content-type-options"], "nosniff", nom);
      assert.equal(res.headers["referrer-policy"], "no-referrer", nom);
    }
    assert.ok(!csp.includes("unsafe"));
  });

  test("Cache-Control: no-store sur /state, et pas sur les fichiers statiques", async () => {
    const { get } = await runningServer();
    assert.equal((await get("/state")).headers["cache-control"], "no-store");
    assert.equal((await get("/js/app.js")).headers["cache-control"], undefined);
  });

  test("un index.html sans importmap donne une CSP sans empreinte", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-public-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><script type="module" src="/js/app.js"></script><p>sans importmap</p>');
    const { get } = await runningServer({ process: { publicArg: dir } });
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.equal(
      res.headers["content-security-policy"],
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  test("l'empreinte suit l'index.html du --public-dir (CRLF compris)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-public-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const texte = '\n{ "imports": { "x": "/x.js" } }\n';
    fs.writeFileSync(path.join(dir, "index.html"), `<html>\r\n<script type="importmap">${texte.replace(/\n/g, "\r\n")}</script>\r\n</html>`);
    const { get } = await runningServer({ process: { publicArg: dir } });
    const attendu = "sha256-" + crypto.createHash("sha256").update(texte).digest("base64");
    assert.ok((await get("/")).headers["content-security-policy"].includes(`'${attendu}'`));
  });
});

describe("échec de gh au démarrage (intégration, sous-processus)", () => {
  test("sert un état sans instantané avec un avertissement GH_AUTH, sans fuite du stderr de gh", async () => {
    const fake = fakeGh([{ match: [], stderr: "SECRET_GH_STDERR_MARKER token=ghp_abc /home/moi/.config/gh", exitCode: 4 }]);
    const { get, proc } = await runningServer({ fake });
    const res = await get("/state");
    assert.equal(res.status, 200);
    const state = JSON.parse(res.body);

    assert.equal(state.repo, null);
    assert.deepEqual(state.features, []);
    assert.deepEqual(state.milestones, []);
    assert.deepEqual(state.releases, []);
    const codes = state.warnings.map((w) => w.code);
    assert.deepEqual(codes.slice(0, 2), ["GH_AUTH", "SNAPSHOT_MISSING"], "avertissements de l'appelant d'abord");
    const auth = state.warnings[0];
    assert.match(auth.message, /gh a échoué/);
    assert.ok(!Number.isNaN(Date.parse(auth.at)));
    assert.ok(!res.body.includes("SECRET_GH_STDERR_MARKER"));
    assert.ok(!res.body.includes("ghp_abc"));
    assert.ok(!Object.keys(auth).includes("detail"));

    // Le journal reste servi, le détail va sur stderr uniquement.
    assert.equal(state.agents.length, 2);
    assert.match(proc.stderr(), /warn instantané GitHub indisponible : GH_AUTH/);
    assert.match(proc.stderr(), /SECRET_GH_STDERR_MARKER/);
    assert.equal((await get("/health")).status, 200);
  });

  test("un .gepet-squad.json illisible donne GH_CONFIG sans chemin local dans /state", async () => {
    const repo = squadRepo({ rawConfig: "{ pas du json" });
    const { get } = await runningServer({ repo });
    const res = await get("/state");
    const state = JSON.parse(res.body);
    assert.equal(state.warnings[0].code, "GH_CONFIG");
    assert.ok(!res.body.includes(repo.dir));
    assert.ok(!res.body.includes(os.tmpdir()));
  });
});

describe("arrêt propre (intégration, sous-processus)", {
  skip: process.platform === "win32" && "Windows ne remet pas SIGINT/SIGTERM au processus (arrêt immédiat) : cycle de vie du verrou couvert par startServer().close()",
}, () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    test(`${signal} supprime viz.lock et termine avec le code 0`, async () => {
      const { repo, proc, get } = await runningServer();
      assert.ok(fs.existsSync(repo.lockFile));
      assert.equal((await get("/health")).status, 200);

      proc.child.kill(signal);
      const { code, signal: received } = await proc.exited;
      assert.equal(code, 0);
      assert.equal(received, null);
      assert.ok(!fs.existsSync(repo.lockFile), "le verrou doit être supprimé");
    });
  }

  test("un arrêt avec une connexion ouverte (keep-alive) n'est pas bloqué", async () => {
    const { repo, proc, port } = await runningServer();
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(() => agent.destroy());
    await new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/health", agent, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });
    proc.child.kill("SIGTERM");
    const { code } = await proc.exited;
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(repo.lockFile));
  });
});
