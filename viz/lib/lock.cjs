"use strict";
// Verrou du serveur : `<git-common-dir>/gepet-squad/viz.lock`, contenu `{ "port": <entier>, "pid": <entier> }`
// (ADR 0005). Ce module porte tout le cycle de vie : lecture, décision « vivant ou périmé », attente, arrêt.
// Le skill `/gepet-squad-viz` ne manipule jamais de pid : il appelle `status` et `stop` de `viz/server.cjs`.
//
// SÉCURITÉ : le fichier est une entrée non fiable (un autre processus local a pu l'écrire). On n'en tire que deux
// entiers validés, `pid` (entier >= 1) et `port` (entier de 1 à 65535). Aucune autre valeur n'est lue, exécutée,
// ouverte ni suivie : l'URL est reconstruite à partir du port, sur 127.0.0.1, et la seule action sur un pid est
// `process.kill`. Un verrou invalide est traité comme périmé.
//
// Les dépendances (vérification du pid, `kill`, horloge, pause, sonde HTTP) sont injectables pour les tests.

const fs = require("fs");
const http = require("http");
const path = require("path");

const { isPlainObject } = require("../../hooks/lib/schema.cjs");

const HOST = "127.0.0.1";
const LOCK_NAME = "viz.lock";
const POLL_INTERVAL_MS = 250; // période de `status --wait`
const STOP_POLL_MS = 50;
const STOP_TIMEOUT_MS = 5000; // attente de la fin du processus après SIGTERM
const KILL_TIMEOUT_MS = 3000; // attente supplémentaire après SIGKILL
const PROBE_TIMEOUT_MS = 2000;
const MAX_LOCK_BYTES = 4096;

/** Le verrou est déjà tenu par un serveur vivant. */
class LockHeldError extends Error {
  constructor(lock, lockFile) {
    super(`Un serveur est déjà lancé pour ce projet (pid ${lock.pid}, port ${lock.port}).`);
    this.name = "LockHeldError";
    this.lock = lock;
    this.lockFile = lockFile;
  }
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------------------------------------------

/**
 * Contenu d'un verrou : `{ pid, port }` validés, ou null (JSON invalide, autre type, pid ou port hors bornes).
 * Les autres champs éventuels sont ignorés.
 */
function parseLock(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  const { pid, port } = value;
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { pid, port };
}

/** URL du serveur, reconstruite à partir du seul port validé. */
function lockUrl(lock) {
  return `http://${HOST}:${lock.port}`;
}

/**
 * Vrai si le contenu de `/proc/<pid>/stat` décrit un processus zombie (état `Z`) : il a fini mais son parent ne l'a
 * pas encore attendu, et `kill(pid, 0)` réussit encore. Le nom de commande est entre parenthèses et peut en contenir.
 */
function isZombieStat(text) {
  const end = String(text).lastIndexOf(")");
  return end !== -1 && String(text).charAt(end + 2) === "Z";
}

// ---------------------------------------------------------------------------------------------------------------
// Processus
// ---------------------------------------------------------------------------------------------------------------

/** Vrai si le processus existe (EPERM : il existe mais appartient à un autre utilisateur). */
function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return Boolean(error) && error.code === "EPERM";
  }
  if (process.platform === "linux") {
    try {
      if (isZombieStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
    } catch {
      // /proc illisible : on s'en tient à kill(pid, 0)
    }
  }
  return true;
}

/**
 * Sonde `GET /health` sur 127.0.0.1:<port> : vrai si c'est bien un serveur de visualisation (`{"ok":true}`).
 * Évite d'arrêter un processus étranger qui aurait récupéré le pid d'un ancien serveur. Aucune redirection suivie.
 */
function probeHealth(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get({ host: HOST, port, path: "/health", agent: false, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024) res.destroy();
      });
      res.on("end", () => {
        try {
          done(res.statusCode === 200 && JSON.parse(body).ok === true);
        } catch {
          done(false);
        }
      });
      res.on("error", () => done(false));
      res.on("close", () => done(false));
    });
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Fichier de verrou
// ---------------------------------------------------------------------------------------------------------------

/** Contenu du verrou `{ pid, port }`, ou null s'il est absent, illisible, trop gros ou invalide. */
function readLock(lockFile) {
  try {
    if (fs.statSync(lockFile).size > MAX_LOCK_BYTES) return null;
    return parseLock(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * État du verrou, sans rien modifier.
 * @returns {{ state: "none" } | { state: "live", lock: object } | { state: "stale", lock: object | null }}
 *   `stale` : le fichier existe mais son pid n'existe plus, ou son contenu est invalide (lock vaut alors null).
 */
function inspectLock(lockFile, { isAlive = isPidAlive } = {}) {
  if (!fs.existsSync(lockFile)) return { state: "none" };
  const lock = readLock(lockFile);
  if (lock && isAlive(lock.pid)) return { state: "live", lock };
  return { state: "stale", lock };
}

/** Comme `inspectLock`, mais supprime un verrou périmé. */
function checkLock(lockFile, deps = {}) {
  const result = inspectLock(lockFile, deps);
  if (result.state === "stale") fs.rmSync(lockFile, { force: true });
  return result;
}

/**
 * Crée le verrou de façon exclusive. Un verrou dont le pid n'existe plus (ou invalide) est périmé : il est remplacé.
 * @throws {LockHeldError} si un autre serveur vivant le détient
 */
function acquireLock(lockFile, port, pid = process.pid, { isAlive = isPidAlive } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const content = JSON.stringify({ port, pid });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, content, { flag: "wx" });
      return;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const lock = readLock(lockFile);
      if (lock && isAlive(lock.pid)) throw new LockHeldError(lock, lockFile);
      fs.rmSync(lockFile, { force: true }); // périmé
    }
  }
  throw new Error(`Impossible de créer le verrou ${lockFile}.`);
}

/** Supprime le verrou s'il appartient à `pid`. Synchrone (appelé aussi à la sortie du processus). */
function releaseLock(lockFile, pid = process.pid) {
  const lock = readLock(lockFile);
  if (lock && lock.pid === pid) fs.rmSync(lockFile, { force: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Attente et arrêt
// ---------------------------------------------------------------------------------------------------------------

/**
 * Attend jusqu'à `seconds` secondes un verrou vivant. Un verrou périmé n'est supprimé qu'au constat final : un
 * serveur en train de démarrer le remplace de lui-même.
 * @returns {Promise<{ state: "none" | "live" | "stale", lock?: object | null }>}
 */
async function waitForLock(lockFile, { seconds, isAlive = isPidAlive, sleep = sleepFor, now = Date.now, intervalMs = POLL_INTERVAL_MS } = {}) {
  const deadline = now() + seconds * 1000;
  for (;;) {
    const result = inspectLock(lockFile, { isAlive });
    if (result.state === "live") return result;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return checkLock(lockFile, { isAlive });
}

/**
 * Arrête le serveur désigné par le verrou : `process.kill` (SIGTERM), attente de la fin du processus, puis
 * suppression du verrou (sous Windows, `process.kill` termine le processus sans lui laisser nettoyer le verrou).
 * Si le processus résiste, SIGKILL, puis échec.
 *
 * Avant d'envoyer un signal, on vérifie que le port du verrou répond comme un serveur de visualisation : sinon le
 * pid a pu être réattribué à un processus étranger (verrou laissé par un serveur tué brutalement) et on n'y touche pas.
 *
 * @returns {Promise<{ state: "none" | "stale", lock?: object | null }
 *   | { state: "stopped", lock: object, forced: boolean }
 *   | { state: "unverified" | "denied" | "survived", lock: object }>}
 */
async function stopServer(
  lockFile,
  {
    isAlive = isPidAlive,
    kill = (pid, signal) => process.kill(pid, signal),
    verify = probeHealth,
    sleep = sleepFor,
    now = Date.now,
    selfPid = process.pid,
    timeoutMs = STOP_TIMEOUT_MS,
    killTimeoutMs = KILL_TIMEOUT_MS,
    intervalMs = STOP_POLL_MS,
  } = {},
) {
  const found = checkLock(lockFile, { isAlive });
  if (found.state !== "live") return found;
  const { lock } = found;
  if (lock.pid === selfPid || !(await verify(lock.port))) return { state: "unverified", lock };

  const waitForExit = async (limitMs) => {
    const deadline = now() + limitMs;
    while (isAlive(lock.pid)) {
      if (now() >= deadline) return false;
      await sleep(intervalMs);
    }
    return true;
  };
  const send = (signal) => {
    try {
      kill(lock.pid, signal);
      return null;
    } catch (error) {
      if (error && error.code === "ESRCH") return null; // déjà terminé
      return { state: "denied", lock };
    }
  };

  let failure = send("SIGTERM");
  if (failure) return failure;
  let forced = false;
  if (!(await waitForExit(timeoutMs))) {
    forced = true;
    failure = send("SIGKILL");
    if (failure) return failure;
    if (!(await waitForExit(killTimeoutMs))) return { state: "survived", lock };
  }
  releaseLock(lockFile, lock.pid);
  return { state: "stopped", lock, forced };
}

module.exports = {
  HOST,
  LOCK_NAME,
  LockHeldError,
  parseLock,
  lockUrl,
  isZombieStat,
  isPidAlive,
  probeHealth,
  readLock,
  inspectLock,
  checkLock,
  acquireLock,
  releaseLock,
  waitForLock,
  stopServer,
};
