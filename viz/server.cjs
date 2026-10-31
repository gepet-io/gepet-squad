#!/usr/bin/env node
"use strict";
// Serveur local, en lecture seule, de la visualisation (ARCHITECTURE § 6 et 7, ADR 0003 et 0005).
//
//   node viz/server.cjs --project <dir> [--port 0] [--public-dir <dir>]
//
// - écoute sur 127.0.0.1 uniquement (port 0 = choix automatique) ;
// - sert `GET /health`, `GET /state`, `GET /events` (SSE) et les fichiers de `--public-dir` (défaut : viz/public) ;
// - écrit `<git-common-dir>/gepet-squad/viz.lock` (`{port, pid}`), supprimé à l'arrêt (SIGINT, SIGTERM) ;
// - l'état de `/state` fusionne l'instantané GitHub et le journal (lu en entier au démarrage, puis suivi par offset).
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

const HOST = "127.0.0.1";
const LOCK_NAME = "viz.lock";
const SNAPSHOT_INTERVAL_MS = 60000;
const DEFAULT_PUBLIC_DIR = path.join(__dirname, "public");
const GH_CODE = /^GH_[A-Z]+$/;

const USAGE = `Usage : node viz/server.cjs --project <dir> [--port 0] [--public-dir <dir>]

  --project <dir>     projet gepet-squad (contient .gepet-squad.json) ; défaut : dossier courant
  --port <n>          port d'écoute sur 127.0.0.1 ; défaut : 0 (choix automatique)
  --public-dir <dir>  fichiers statiques ; défaut : viz/public
`;

/** Erreur de démarrage : message clair destiné à l'utilisateur, affiché sur stderr, puis sortie non nulle. */
class StartupError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "StartupError";
    this.exitCode = exitCode;
  }
}

function log(level, message) {
  process.stderr.write(`[gepet-squad-viz] ${level} ${message}\n`);
}

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------------------------------------------

/**
 * Analyse la ligne de commande.
 * @param {string[]} argv arguments après `node viz/server.cjs`
 * @param {string} [cwd] dossier courant (base des chemins relatifs)
 * @returns {{ help: true } | { help: false, project: string, port: number, publicDir: string }}
 * @throws {StartupError} (code de sortie 2) pour une option ou une valeur invalide
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
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new StartupError(`${error.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length > 0) {
    throw new StartupError(`Argument inattendu : « ${positionals[0]} ».\n${USAGE}`, 2);
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
    project: path.resolve(cwd, values.project === undefined ? "." : values.project),
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
// Verrou viz.lock
// ---------------------------------------------------------------------------------------------------------------

/** Vrai si le processus existe (EPERM : il existe mais appartient à un autre utilisateur). */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === "EPERM";
  }
}

/** Contenu du verrou `{ port, pid }`, ou null s'il est absent ou illisible. */
function readLock(lockFile) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    return isPlainObject(lock) && Number.isInteger(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

function alreadyRunning(lock, lockFile) {
  return new StartupError(
    `Un serveur est déjà lancé pour ce projet (pid ${lock.pid}, port ${lock.port}). ` +
      `S'il n'existe plus, supprimer ${lockFile}.`,
  );
}

/** Lève StartupError si le verrou désigne un processus vivant. Ne supprime rien. */
function assertNoLiveServer(lockFile) {
  const lock = readLock(lockFile);
  if (lock && isPidAlive(lock.pid)) throw alreadyRunning(lock, lockFile);
}

/**
 * Crée le verrou de façon exclusive. Un verrou dont le pid n'existe plus (ou illisible) est périmé : il est remplacé.
 * @throws {StartupError} si un autre serveur vivant le détient
 */
function acquireLock(lockFile, port, pid = process.pid) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const content = JSON.stringify({ port, pid });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, content, { flag: "wx" });
      return;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const lock = readLock(lockFile);
      if (lock && isPidAlive(lock.pid)) throw alreadyRunning(lock, lockFile);
      fs.rmSync(lockFile, { force: true }); // périmé
    }
  }
  throw new StartupError(`Impossible de créer le verrou ${lockFile}.`);
}

/** Supprime le verrou s'il appartient à ce processus. Synchrone (appelé aussi à la sortie du processus). */
function releaseLock(lockFile, pid = process.pid) {
  const lock = readLock(lockFile);
  if (lock && lock.pid === pid) fs.rmSync(lockFile, { force: true });
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
 * Démarre le serveur. Aucun signal ni `process.exit` ici : voir `main`.
 * @param {object} options
 * @param {string} options.project dossier du projet gepet-squad
 * @param {number} options.port port d'écoute (0 = automatique)
 * @param {string} options.publicDir fichiers statiques
 * @param {number} [options.snapshotIntervalMs] période du recalage GitHub (60 000 ms) ; injectable pour les tests
 * @param {number} [options.pollIntervalMs] période du suivi du journal (500 ms)
 * @param {number} [options.heartbeatMs] période du battement SSE (15 000 ms)
 * @param {number} [options.generation] génération initiale du journal (l'horloge : voir tail.cjs)
 * @returns {Promise<{ port: number, url: string, lockFile: string, getState: () => object, clientCount: () => number, close: () => Promise<void> }>}
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
  const lockFile = path.join(paths.dir, LOCK_NAME);
  assertNoLiveServer(lockFile);

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
  };

  // Recalage : un instantané GitHub à intervalle fixe (la prochaine tentative part à la fin de la précédente, donc
  // sans chevauchement). En cas d'échec, le dernier instantané est conservé et un `warning` est poussé.
  let closed = false;
  let recalTimer = null;
  const scheduleRecalibration = () => {
    if (closed) return;
    recalTimer = setTimeout(recalibrate, snapshotIntervalMs);
    recalTimer.unref();
  };
  async function recalibrate() {
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
    }
    scheduleRecalibration();
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
    throw error;
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

async function main(argv) {
  let options;
  try {
    options = parseCli(argv);
    if (options.help) {
      process.stdout.write(USAGE);
      return 0;
    }
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
    if (error instanceof StartupError) {
      log("error", error.message);
      return error.exitCode;
    }
    log("error", `démarrage impossible : ${error && error.message ? error.message : "erreur inconnue"}`);
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
  parseCli,
  parseJournal,
  warningFromError,
  isPidAlive,
  acquireLock,
  releaseLock,
  startServer,
  main,
};
