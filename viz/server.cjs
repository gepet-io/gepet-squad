#!/usr/bin/env node
"use strict";
// Serveur local, en lecture seule, de la visualisation (ARCHITECTURE § 6 et 7, ADR 0003 et 0005).
//
//   node viz/server.cjs [start] --project <dir> [--port 0] [--public-dir <dir>]
//   node viz/server.cjs status --project <dir> [--wait <s>]
//   node viz/server.cjs stop   --project <dir>
//
// - écoute sur 127.0.0.1 uniquement (port 0 = choix automatique) ;
// - sert `GET /health`, `GET /state`, `GET /events` (SSE) et les fichiers de `--public-dir` (défaut : viz/public) ;
// - écrit `<git-common-dir>/gepet-squad/viz.lock` (`{port, pid}`), supprimé à l'arrêt (SIGINT, SIGTERM) ;
// - l'état de `/state` fusionne l'instantané GitHub et le journal (lu en entier au démarrage, puis suivi par offset) ;
// - un second démarrage pour le même projet n'ouvre rien : il affiche l'URL du serveur vivant (stdout) et sort avec 0 ;
// - « vivant » a une seule définition, pour `status`, le démarrage et `stop` : le pid du verrou existe ET `GET /health`
//   sur le port du verrou répond `{"ok":true,"pid":<ce pid>}` (ADR 0005, lib/lock.cjs) ;
// - `status` affiche l'URL (stdout, code 0) si le serveur est vivant, sinon code 1 et supprime un verrou périmé ou
//   invalide (`--wait <s>` attend jusqu'à <s> secondes un verrou vivant : le serveur n'écoute qu'après son premier
//   instantané GitHub, jusqu'à 15 s, d'où `status --wait 20` juste après un démarrage) ;
// - `stop` arrête le serveur vivant par `process.kill`, attend sa fin, supprime le verrou ; sans serveur vivant :
//   code 1, verrou périmé supprimé, aucun signal envoyé.
//   La logique du verrou (pid, /health, arrêt) est dans lib/lock.cjs, la même sous Windows, macOS et Linux.
//
// Flux `GET /events` (ADR 0002 et 0003). Trois noms d'événements, `data` est toujours une chaîne JSON :
//   - `evt`      : un événement v1 du journal, avec `id: <génération>:<offset>` ;
//   - `snapshot` : l'état `/state` complet (recalage toutes les 60 s, ou reprise impossible), avec `id` ;
//   - `warning`  : `{ code, message, at }` quand le recalage GitHub échoue (le dernier instantané est conservé).
// Un battement (commentaire) part toutes les 15 s. Reprise : `Last-Event-ID` de la génération courante -> les
// événements postérieurs ; inconnu ou d'une autre génération -> `snapshot`, puis le flux.
//
// Le journal et le fichier de verrou sont dans le dossier commun de git, comme pour le collecteur : la résolution
// vient de hooks/lib/journal.cjs. Journaux du serveur sur stderr : `[gepet-squad-viz] niveau message`.
//
// SÉCURITÉ : `fetchSnapshot` est appelé sans `ghBin` ni `execFile`. Aucune entrée externe (ligne de commande,
// requête HTTP) ne choisit le binaire lancé. Les erreurs de `gh` ne sont exposées que par `code` et `message`
// (génériques) ; `detail` (stderr brut de `gh`) ne va que sur stderr.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { parseArgs } = require("util");

const { findSquadRoot, journalPaths, resolveCommonDir } = require("../hooks/lib/journal.cjs");
const { isPlainObject, validate } = require("../hooks/lib/schema.cjs");
const { fetchSnapshot, GhError } = require("./lib/github.cjs");
const { reduce } = require("./lib/reducer.cjs");
const {
  importmapHash,
  buildCsp,
  createRequestListener,
  createSseHub,
  formatSse,
} = require("./lib/http.cjs");
const { createTail, formatEventId, planResume } = require("./lib/tail.cjs");
const {
  HOST,
  LOCK_NAME,
  LockHeldError,
  acquireLock,
  checkLock,
  isPidAlive,
  lockUrl,
  releaseLock,
  stopServer,
  waitForLock,
} = require("./lib/lock.cjs");

const SNAPSHOT_INTERVAL_MS = 180000;
const DEFAULT_PUBLIC_DIR = path.join(__dirname, "public");
const GH_CODE = /^GH_[A-Z]+$/;

const USAGE = `Usage :
  node viz/server.cjs [start] --project <dir> [--port 0] [--public-dir <dir>]
  node viz/server.cjs status --project <dir> [--wait <s>]
  node viz/server.cjs stop --project <dir>

  start    démarre le serveur (commande par défaut) ; s'il en existe déjà un pour le projet, affiche son URL et sort avec 0
  status   affiche l'URL du serveur et sort avec 0 s'il est vivant (pid existant ET /health qui répond avec ce pid) ;
           sinon sort avec 1 et supprime un verrou périmé
  stop     arrête le serveur et supprime le verrou ; sans serveur vivant, sort avec 1 sans envoyer de signal

  --project <dir>     projet gepet-squad (contient .gepet-squad.json) ; défaut : dossier courant
  --port <n>          (start) port d'écoute sur 127.0.0.1 ; défaut : 0 (choix automatique)
  --public-dir <dir>  (start) fichiers statiques ; défaut : viz/public
  --wait <s>          (status) attend jusqu'à <s> secondes un serveur vivant (le premier instantané GitHub peut
                      retarder l'écoute de 15 s : utiliser 20 juste après un démarrage)
`;

const COMMANDS = ["start", "status", "stop"];
const MAX_WAIT_SECONDS = 3600;

/** Erreur de démarrage : message clair destiné à l'utilisateur, affiché sur stderr, puis sortie non nulle. */
class StartupError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "StartupError";
    this.exitCode = exitCode;
  }
}

/** Un serveur vivant tient déjà le verrou de ce projet : ce n'est pas un échec, `main` affiche son URL et sort avec 0. */
class AlreadyRunningError extends StartupError {
  constructor(lock) {
    super(`Un serveur est déjà lancé pour ce projet (pid ${lock.pid}, port ${lock.port}).`, 0);
    this.name = "AlreadyRunningError";
    this.lock = lock;
  }
}

function log(level, message) {
  process.stderr.write(`[gepet-squad-viz] ${level} ${message}\n`);
}

function writeOut(text) {
  process.stdout.write(text);
}

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------------------------------------------

/**
 * Analyse la ligne de commande : une sous-commande facultative (`start` par défaut), puis des options. Une option
 * n'est acceptée que pour la sous-commande qui l'utilise.
 * @param {string[]} argv arguments après `node viz/server.cjs`
 * @param {string} [cwd] dossier courant (base des chemins relatifs)
 * @returns {{ help: true }
 *   | { help: false, command: "start", project: string, port: number, publicDir: string }
 *   | { help: false, command: "status", project: string, wait: number }
 *   | { help: false, command: "stop", project: string }}
 * @throws {StartupError} (code de sortie 2) pour une sous-commande, une option ou une valeur invalide
 */
function parseCli(argv, cwd = process.cwd()) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: "string" },
        port: { type: "string" },
        "public-dir": { type: "string" },
        wait: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new StartupError(`${error.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length > 1) {
    throw new StartupError(`Argument inattendu : « ${positionals[1]} ».\n${USAGE}`, 2);
  }
  const command = positionals.length === 0 ? "start" : positionals[0];
  if (!COMMANDS.includes(command)) {
    throw new StartupError(`Sous-commande inconnue : « ${command} » (start, status ou stop).\n${USAGE}`, 2);
  }
  const allowed = { start: ["port", "public-dir"], status: ["wait"], stop: [] }[command];
  for (const option of ["port", "public-dir", "wait"]) {
    if (values[option] !== undefined && !allowed.includes(option)) {
      throw new StartupError(`--${option} n'est pas une option de « ${command} ».\n${USAGE}`, 2);
    }
  }

  const project = path.resolve(cwd, values.project === undefined ? "." : values.project);
  if (command === "stop") return { help: false, command, project };
  if (command === "status") {
    let wait = 0;
    if (values.wait !== undefined) {
      if (!/^\d{1,4}(\.\d{1,3})?$/.test(values.wait) || Number(values.wait) > MAX_WAIT_SECONDS) {
        throw new StartupError(`--wait doit être un nombre de secondes entre 0 et ${MAX_WAIT_SECONDS} (reçu « ${values.wait} »).`, 2);
      }
      wait = Number(values.wait);
    }
    return { help: false, command, project, wait };
  }

  let port = 0;
  if (values.port !== undefined) {
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) {
      throw new StartupError(`--port doit être un entier entre 0 et 65535 (reçu « ${values.port} »).`, 2);
    }
    port = Number(values.port);
  }
  return {
    help: false,
    command,
    project,
    port,
    publicDir: values["public-dir"] === undefined ? DEFAULT_PUBLIC_DIR : path.resolve(cwd, values["public-dir"]),
  };
}

/**
 * Événements d'un texte JSONL. Les lignes vides sont ignorées ; une ligne qui n'est pas un objet JSON est comptée
 * dans `skipped`. Le contrôle fin (version, type, champs obligatoires) est celui du réducteur.
 * @returns {{ events: object[], skipped: number }}
 */
function parseJournal(text) {
  const events = [];
  let skipped = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (isPlainObject(value)) events.push(value);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

/**
 * Entrée de `warnings[]` pour une erreur d'instantané. Seuls `code` et `message` (génériques) sont exposés ; le
 * `detail` d'une GhError (stderr brut de `gh`, chemins locaux) n'en sort jamais.
 */
function warningFromError(error, at) {
  if (error instanceof GhError && GH_CODE.test(error.code)) {
    return { code: error.code, message: error.message, at };
  }
  return { code: "GH_PARSE", message: "Instantané GitHub impossible à construire.", at };
}

// ---------------------------------------------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------------------------------------------

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Événements de l'ancien fichier du journal (rotation, `events.1.jsonl`), lus une fois au démarrage. Le fichier
 * courant est lu et suivi par `createTail`. Une ligne qui ne passe pas `validate()` est ignorée, comme dans le suivi.
 * Un fichier illisible est signalé et ignoré.
 */
function loadRotatedJournal(file) {
  let text = "";
  try {
    text = readIfExists(file);
  } catch (error) {
    log("warn", `journal illisible (${error && error.code ? error.code : "erreur"}) : ${file}`);
  }
  const { events, skipped } = parseJournal(text);
  const valid = events.filter((event) => validate(event).valid);
  const ignored = skipped + (events.length - valid.length);
  if (ignored > 0) log("warn", `${ignored} ligne(s) du journal ignorée(s) : ${file}`);
  return valid;
}

/** CSP de la page : empreinte de l'importmap de `index.html`, ou aucune empreinte s'il n'y en a pas. */
function loadCsp(publicDir) {
  let html = "";
  try {
    html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  } catch {
    log("warn", `index.html illisible dans ${publicDir} : la page ne sera pas servie`);
  }
  return buildCsp(importmapHash(html));
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

/**
 * Emplacement du verrou d'un projet : racine squad (`.gepet-squad.json`), puis dossier commun de git.
 * @returns {{ root: string, paths: ReturnType<typeof journalPaths>, lockFile: string }}
 * @throws {StartupError}
 */
function locateProject(project) {
  const root = findSquadRoot(project);
  if (root === null) {
    throw new StartupError(
      `.gepet-squad.json introuvable depuis ${project} : ce dossier n'est pas un projet gepet-squad.`,
    );
  }
  let commonDir;
  try {
    commonDir = resolveCommonDir(root);
  } catch {
    throw new StartupError(`Impossible de trouver le dossier git de ${root} (git est-il installé, le dossier est-il un repo ?).`);
  }
  const paths = journalPaths(commonDir);
  return { root, paths, lockFile: path.join(paths.dir, LOCK_NAME) };
}

/**
 * Démarre le serveur. Aucun signal ni `process.exit` ici : voir `main`.
 * @param {object} options
 * @param {string} options.project dossier du projet gepet-squad
 * @param {number} options.port port d'écoute (0 = automatique)
 * @param {string} options.publicDir fichiers statiques
 * @param {number} [options.snapshotIntervalMs] période du recalage GitHub (180 000 ms, sauté sans client connecté) ; injectable pour les tests
 * @param {number} [options.pollIntervalMs] période du suivi du journal (500 ms)
 * @param {number} [options.heartbeatMs] période du battement SSE (15 000 ms)
 * @param {number} [options.generation] génération initiale du journal (l'horloge : voir tail.cjs)
 * @returns {Promise<{ port: number, url: string, lockFile: string, getState: () => object, clientCount: () => number, close: () => Promise<void> }>}
 * @throws {AlreadyRunningError} un serveur vivant tient déjà le verrou du projet (rien n'est démarré)
 * @throws {StartupError}
 */
async function startServer({
  project,
  port,
  publicDir,
  snapshotIntervalMs = SNAPSHOT_INTERVAL_MS,
  pollIntervalMs,
  heartbeatMs,
  generation = Date.now(),
}) {
  const { root, paths, lockFile } = locateProject(project);
  const held = await checkLock(lockFile); // supprime un verrou périmé ou invalide
  if (held.state === "live") throw new AlreadyRunningError(held.lock);

  const events = loadRotatedJournal(paths.rotated);
  const csp = loadCsp(publicDir);

  // Instantané GitHub : en cas d'échec, on sert quand même l'état du journal seul, avec un avertissement.
  let snapshot = null;
  let warnings = [];
  const recordFailure = (error) => {
    const warning = warningFromError(error, new Date().toISOString());
    log("warn", `instantané GitHub indisponible : ${warning.code} ${warning.message}`);
    if (error instanceof GhError && error.detail) log("warn", `détail gh : ${error.detail}`);
    return warning;
  };
  try {
    snapshot = await fetchSnapshot({ cwd: root });
  } catch (error) {
    warnings = [recordFailure(error)];
  }

  const getState = () => reduce(snapshot, events, new Date(), { warnings });
  const hub = createSseHub({ csp, heartbeatMs, log });

  // Suivi du journal. `replay` : messages `evt` de la génération courante, pour la reprise par Last-Event-ID.
  let replay = [];
  const tail = createTail({
    file: paths.events,
    rotatedFile: paths.rotated,
    intervalMs: pollIntervalMs,
    generation,
    onEvent({ event, generation: gen, offset }) {
      events.push(event);
      const message = formatSse({ event: "evt", id: formatEventId(gen, offset), data: event });
      replay.push({ offset, message });
      hub.broadcast(message);
    },
    onRotate(newGeneration) {
      replay = [];
      log("info", `journal recréé (rotation) : génération ${newGeneration}`);
    },
    onSkip: (count) => log("warn", `${count} ligne(s) du journal ignorée(s) (JSON ou schéma invalide)`),
    onError: (error) => log("warn", `suivi du journal : ${error && error.code ? error.code : "erreur"}`),
  });
  tail.start();

  // Message `snapshot` : l'identifiant est la position courante, pour qu'une reconnexion reprenne juste après.
  const snapshotMessage = () =>
    formatSse({ event: "snapshot", id: formatEventId(tail.generation, tail.offset), data: getState() });

  const openEvents = (req, res) => {
    const plan = planResume(req.headers["last-event-id"], { generation: tail.generation, end: tail.offset });
    const initial = [];
    if (plan.snapshot) initial.push(snapshotMessage());
    else if (plan.after !== null) for (const entry of replay) if (entry.offset > plan.after) initial.push(entry.message);
    hub.open(res, initial);
    recalibrateIfMissed();
  };

  // Recalage : un instantané GitHub à intervalle fixe (la prochaine tentative part à la fin de la précédente, donc
  // sans chevauchement). En cas d'échec, le dernier instantané est conservé et un `warning` est poussé.
  // Sans client connecté (page fermée ou onglet en arrière-plan), le recalage est sauté pour ne pas consommer d'appels
  // GitHub ; le premier client qui se reconnecte déclenche aussitôt le recalage manqué.
  let closed = false;
  let recalTimer = null;
  let inFlight = false;
  let missed = false;
  const scheduleRecalibration = () => {
    if (closed) return;
    recalTimer = setTimeout(recalibrate, snapshotIntervalMs);
    recalTimer.unref();
  };
  async function recalibrate() {
    recalTimer = null;
    if (hub.size === 0) {
      missed = true;
      scheduleRecalibration();
      return;
    }
    missed = false;
    inFlight = true;
    try {
      const next = await fetchSnapshot({ cwd: root });
      if (closed) return;
      snapshot = next;
      warnings = [];
      hub.broadcast(snapshotMessage());
    } catch (error) {
      if (closed) return;
      const warning = recordFailure(error);
      warnings = [warning];
      hub.broadcast(formatSse({ event: "warning", data: warning }));
    } finally {
      inFlight = false;
    }
    scheduleRecalibration();
  }
  function recalibrateIfMissed() {
    if (closed || inFlight || !missed) return;
    if (recalTimer !== null) clearTimeout(recalTimer);
    recalibrate();
  }
  scheduleRecalibration();

  const stopBackground = () => {
    closed = true;
    if (recalTimer !== null) clearTimeout(recalTimer);
    tail.stop();
    hub.close();
  };

  let actualPort = 0;
  const server = http.createServer(
    createRequestListener({ getPort: () => actualPort, getState, publicDir, csp, openEvents, log }),
  );
  try {
    actualPort = await listen(server, port);
  } catch (error) {
    stopBackground();
    const reason = error && error.code === "EADDRINUSE" ? `le port ${port} est déjà utilisé` : error.message;
    throw new StartupError(`Impossible d'écouter sur ${HOST}:${port} : ${reason}.`);
  }
  try {
    acquireLock(lockFile, actualPort);
  } catch (error) {
    stopBackground();
    server.close();
    server.closeAllConnections();
    // Course entre deux démarrages simultanés : l'autre a pris le verrou entre la vérification et ici.
    throw error instanceof LockHeldError ? new AlreadyRunningError(error.lock) : error;
  }

  const close = () => {
    stopBackground();
    releaseLock(lockFile);
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  const url = `http://${HOST}:${actualPort}`;
  return { port: actualPort, url, lockFile, getState, clientCount: () => hub.size, close };
}

/**
 * `status` : URL du serveur vivant sur stdout et code 0 ; sinon message sur stderr et code 1 (un verrou périmé ou
 * invalide est supprimé). Avec `wait` > 0, attend ce nombre de secondes un verrou vivant.
 * @param {{ project: string, wait?: number }} options
 * @param {{ out?: (text: string) => void, say?: (level: string, message: string) => void }} [deps] sorties, puis
 *   dépendances de lib/lock.cjs (isAlive, probe, sleep, now) injectables pour les tests
 * @returns {Promise<number>} code de sortie
 * @throws {StartupError}
 */
async function runStatus({ project, wait = 0 }, { out = writeOut, say = log, ...lockDeps } = {}) {
  const { lockFile } = locateProject(project);
  const result =
    wait > 0 ? await waitForLock(lockFile, { seconds: wait, ...lockDeps }) : await checkLock(lockFile, lockDeps);
  if (result.state === "live") {
    out(`${lockUrl(result.lock)}\n`);
    return 0;
  }
  if (result.state === "stale" || result.state === "invalid") say("warn", staleMessage(result, lockFile));
  say("error", wait > 0 ? `Aucun serveur lancé pour ce projet (attendu ${wait} s).` : "Aucun serveur lancé pour ce projet.");
  return 1;
}

/** Message pour un verrou `stale` ou `invalid` qui vient d'être supprimé. */
function staleMessage({ state, lock, reason }, lockFile) {
  if (state === "invalid") return "Verrou illisible ou invalide supprimé.";
  if (reason === "unanswered") {
    return (
      `Verrou périmé supprimé (${lockFile}) : le processus ${lock.pid} existe, mais le port ${lock.port} ne répond pas ` +
      "comme son serveur de visualisation (/health muet, hors délai ou avec un autre pid) ; le pid a pu être réattribué."
    );
  }
  return `Verrou périmé supprimé : le processus ${lock.pid} n'existe plus.`;
}

/**
 * `stop` : arrête le serveur vivant, attend sa fin et supprime le verrou (code 0) ; sans serveur vivant, ou si
 * l'arrêt échoue, message sur stderr et code 1. Un verrou périmé est supprimé sans qu'aucun signal soit envoyé.
 * @param {{ project: string }} options
 * @param {{ say?: (level: string, message: string) => void }} [deps] sortie, puis dépendances de `stopServer`
 * @returns {Promise<number>} code de sortie
 * @throws {StartupError}
 */
async function runStop({ project }, { say = log, ...stopDeps } = {}) {
  const { lockFile } = locateProject(project);
  const result = await stopServer(lockFile, stopDeps);
  switch (result.state) {
    case "stopped":
      say("info", `Serveur arrêté (pid ${result.lock.pid}, port ${result.lock.port})${result.forced ? " : arrêt forcé (SIGKILL)" : ""}.`);
      return 0;
    case "stale":
    case "invalid":
      say("warn", staleMessage(result, lockFile));
      if (result.reason === "unanswered") say("warn", `Aucun signal n'a été envoyé au processus ${result.lock.pid}.`);
      say("error", "Aucun serveur lancé pour ce projet.");
      return 1;
    case "none":
      say("error", "Aucun serveur lancé pour ce projet.");
      return 1;
    case "self":
      say("error", `Le verrou désigne le processus courant (pid ${result.lock.pid}) : arrêt refusé.`);
      return 1;
    case "denied":
      say("error", `Permission refusée pour arrêter le processus ${result.lock.pid}.`);
      return 1;
    default:
      say("error", `Le processus ${result.lock.pid} ne s'est pas arrêté.`);
      return 1;
  }
}

/** `start` : lance le serveur, qui tient le processus en vie. S'il en existe déjà un, affiche son URL (code 0). */
async function runStart(options) {
  try {
    const running = await startServer(options);
    log("info", running.url);

    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      running.close().finally(() => process.exit(0));
    };
    // Dernier filet : le verrou disparaît aussi si le processus se termine autrement (exception, process.exit).
    process.on("exit", () => releaseLock(running.lockFile));
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(signal, stop);
    return null; // le serveur tient le processus en vie
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      writeOut(`${lockUrl(error.lock)}\n`);
      log("info", `${error.message} Aucun second serveur n'est démarré.`);
      return 0;
    }
    throw error;
  }
}

/** @returns {Promise<number | null>} code de sortie, ou null si le serveur tourne (il tient le processus en vie) */
async function main(argv) {
  try {
    const options = parseCli(argv);
    if (options.help) {
      writeOut(USAGE);
      return 0;
    }
    if (options.command === "status") return await runStatus(options);
    if (options.command === "stop") return await runStop(options);
    return await runStart(options);
  } catch (error) {
    if (error instanceof StartupError) {
      log("error", error.message);
      return error.exitCode;
    }
    log("error", `${error && error.message ? error.message : "erreur inconnue"}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    // `exitCode` plutôt que `process.exit` : stderr (tube asynchrone sous Windows) doit finir d'écrire le message.
    if (code !== null) process.exitCode = code;
  });
}

module.exports = {
  StartupError,
  AlreadyRunningError,
  parseCli,
  parseJournal,
  warningFromError,
  isPidAlive,
  locateProject,
  startServer,
  runStatus,
  runStop,
  main,
};
