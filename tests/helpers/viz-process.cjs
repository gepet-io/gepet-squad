// Lancement de `node viz/server.cjs` en sous-processus, pour les tests d'intégration du serveur
// (tests/viz-server/server.test.cjs et lifecycle.test.cjs).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..", "..");
const SERVER_CJS = path.join(REPO_ROOT, "viz", "server.cjs");
const PRELOAD = path.join(__dirname, "gh-preload.cjs");
const GH_FIXTURES = path.join(__dirname, "..", "fixtures", "gh-json");
const PUBLIC_REL = "tests/fixtures/public/";

/** Routes du faux `gh` : l'instantané GitHub de tests/fixtures/gh-json (repo `o/r`). */
function ghFixtureRoutes() {
  const fixture = (name) => JSON.parse(fs.readFileSync(path.join(GH_FIXTURES, name), "utf8"));
  return [
    { match: ["api", "-X", "GET", "repos/o/r/milestones"], json: fixture("milestones.json") },
    { match: ["issue", "list", "--repo", "o/r"], json: fixture("issues.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "open"], json: fixture("pulls-open.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "develop"], json: fixture("pulls-merged-develop.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "main"], json: fixture("pulls-merged-main.json") },
  ];
}

/**
 * Environnement et arguments de Node pour un sous-processus. Sous Windows, le faux gh (un .cmd) est branché par un
 * module préchargé (voir gh-preload.cjs) ; ailleurs `gh` est trouvé dans le PATH, comme en production.
 */
function spawnSetup(fake) {
  const env = fake ? fake.env() : { ...process.env };
  const execArgv = [];
  if (fake && process.platform === "win32") {
    env.GEPET_TEST_FAKE_GH_SCRIPT = path.join(fake.dir, "fake-gh.cjs");
    execArgv.push("--require", PRELOAD);
  }
  return { env, execArgv };
}

function collect(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { output, exited };
}

/**
 * Lance `node viz/server.cjs` et attend la ligne d'information sur stderr.
 * L'appelant enregistre son propre nettoyage (`child.kill("SIGKILL")`).
 * @returns {{ child: object, exited: Promise<{code: number|null, signal: string|null}>, ready: Promise<number>, stderr: () => string, stdout: () => string }}
 *   `ready` donne le port, et est rejetée si le serveur s'arrête (ou tarde plus de 15 s) avant d'être prêt.
 */
function startVizProcess({ project, fake, extraArgs = [], publicArg = PUBLIC_REL, cwd = REPO_ROOT }) {
  const { env, execArgv } = spawnSetup(fake);
  const args = [...execArgv, SERVER_CJS, "--project", project];
  if (publicArg) args.push("--public-dir", publicArg);
  args.push(...extraArgs);

  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const { output, exited } = collect(child);

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serveur non prêt après 15 s. stderr :\n${output.stderr}`)), 15000);
    const check = () => {
      const match = /\[gepet-squad-viz\] info http:\/\/127\.0\.0\.1:(\d+)\n/.exec(output.stderr);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stderr.on("data", check);
    exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`serveur arrêté (code ${code}) avant d'être prêt. stderr :\n${output.stderr}`));
    });
  });
  // Évite un rejet non géré si le test attend `exited` à la place de `ready`.
  ready.catch(() => {});
  return { child, exited, ready, stderr: () => output.stderr, stdout: () => output.stdout };
}

/**
 * Exécute `node viz/server.cjs <args>` jusqu'à sa fin. Toujours asynchrone (jamais spawnSync) : un serveur lancé par
 * le test doit pouvoir être attendu par la boucle d'événements du test, sinon il reste zombie après un `stop`.
 * @returns {{ child: object, done: Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}> }}
 */
function spawnVizCli(args, { fake, cwd = REPO_ROOT } = {}) {
  const { env, execArgv } = spawnSetup(fake);
  const child = spawn(process.execPath, [...execArgv, SERVER_CJS, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const { output, exited } = collect(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  const done = exited.then(({ code, signal }) => {
    clearTimeout(timer);
    return { code, signal, stdout: output.stdout, stderr: output.stderr };
  });
  return { child, done };
}

/** Comme `spawnVizCli`, en attendant la fin du processus. */
function runVizCli(args, options) {
  return spawnVizCli(args, options).done;
}

module.exports = { REPO_ROOT, SERVER_CJS, PUBLIC_REL, ghFixtureRoutes, startVizProcess, spawnVizCli, runVizCli };
