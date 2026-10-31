#!/usr/bin/env node
"use strict";
// Serveur local, en lecture seule, de la visualisation (ARCHITECTURE § 6 et 7, ADR 0003 et 0005).
//
//   node viz/server.cjs --project <dir> [--port 0] [--public-dir <dir>]
//
// - écoute sur 127.0.0.1 uniquement (port 0 = choix automatique) ;
// - sert `GET /health`, `GET /state` et les fichiers de `--public-dir` (défaut : viz/public) ;
// - écrit `<git-common-dir>/gepet-squad/viz.lock` (`{port, pid}`), supprimé à l'arrêt (SIGINT, SIGTERM) ;
// - l'état de `/state` fusionne l'instantané GitHub (pris au démarrage) et le journal (lu en entier au démarrage).
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
const { isPlainObject } = require("../hooks/lib/schema.cjs");
const { fetchSnapshot, GhError } = require("./lib/github.cjs");
const { reduce } = require("./lib/reducer.cjs");
const { importmapHash, buildCsp, createRequestListener } = require("./lib/http.cjs");

const HOST = "127.0.0.1";
const LOCK_NAME = "viz.lock";
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

/** Journal complet : l'ancien fichier (rotation) puis le courant. Un fichier illisible est signalé et ignoré. */
function loadJournal(paths) {
  const events = [];
  let skipped = 0;
  for (const file of [paths.rotated, paths.events]) {
    let text = "";
    try {
      text = readIfExists(file);
    } catch (error) {
      log("warn", `journal illisible (${error && error.code ? error.code : "erreur"}) : ${file}`);
    }
    const result = parseJournal(text);
    events.push(...result.events);
    skipped += result.skipped;
  }
  if (skipped > 0) log("warn", `${skipped} ligne(s) du journal ignorée(s) (JSON invalide)`);
  return events;
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
 * @param {{ project: string, port: number, publicDir: string }} options
 * @returns {Promise<{ port: number, url: string, lockFile: string, getState: () => object, close: () => Promise<void> }>}
 * @throws {StartupError}
 */
async function startServer({ project, port, publicDir }) {
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

  const events = loadJournal(paths);
  const csp = loadCsp(publicDir);

  // Instantané GitHub : en cas d'échec, on sert quand même l'état du journal seul, avec un avertissement.
  let snapshot = null;
  const warnings = [];
  try {
    snapshot = await fetchSnapshot({ cwd: root });
  } catch (error) {
    const warning = warningFromError(error, new Date().toISOString());
    warnings.push(warning);
    log("warn", `instantané GitHub indisponible : ${warning.code} ${warning.message}`);
    if (error instanceof GhError && error.detail) log("warn", `détail gh : ${error.detail}`);
  }

  let actualPort = 0;
  const getState = () => reduce(snapshot, events, new Date(), { warnings });
  const server = http.createServer(
    createRequestListener({ getPort: () => actualPort, getState, publicDir, csp, log }),
  );
  try {
    actualPort = await listen(server, port);
  } catch (error) {
    const reason = error && error.code === "EADDRINUSE" ? `le port ${port} est déjà utilisé` : error.message;
    throw new StartupError(`Impossible d'écouter sur ${HOST}:${port} : ${reason}.`);
  }
  try {
    acquireLock(lockFile, actualPort);
  } catch (error) {
    server.close();
    server.closeAllConnections();
    throw error;
  }

  const close = () => {
    releaseLock(lockFile);
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  const url = `http://${HOST}:${actualPort}`;
  return { port: actualPort, url, lockFile, getState, close };
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
