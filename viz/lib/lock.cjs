"use strict";
// Verrou du serveur : `<git-common-dir>/gepet-squad/viz.lock`, contenu `{ "port": <entier>, "pid": <entier> }`
// (ADR 0005). Ce module porte tout le cycle de vie : lecture, décision « vivant ou périmé », attente, arrêt.
// Le skill `/gepet-squad-viz` ne manipule jamais de pid : il appelle `status` et `stop` de `viz/server.cjs`.
//
// DÉFINITION DE « VIVANT » (une seule, pour `status`, le démarrage et `stop`) : le pid du verrou existe ET
// `GET /health` sur le port du verrou répond `{"ok":true,"pid":<ce même pid>}`. Un pid réattribué à un autre
// processus après un redémarrage de la machine, ou un port tenu par un autre programme, ne passent pas ce test.
// Trois états (`inspectLock`) : `live`, `stale` (pid mort, ou /health muet, hors délai, trop gros ou incohérent) et
// `invalid` (contenu corrompu).
//
// SÉCURITÉ : le fichier est une entrée non fiable (un autre processus local a pu l'écrire). On n'en tire que deux
// entiers validés, `pid` (entier >= 1) et `port` (entier de 1 à 65535). Aucune autre valeur n'est lue, exécutée,
// ouverte ni suivie : l'URL est reconstruite à partir du port, sur 127.0.0.1, et la seule action sur un pid est
// `process.kill`. Un verrou invalide est traité comme périmé. La réponse de /health est elle aussi non fiable : on
// n'en tire qu'un entier (le pid), après un délai maximal et une taille maximale ; rien n'est exécuté.
//
// Les dépendances (vérification du pid, sonde /health, `kill`, horloge, pause) sont injectables pour les tests.

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
const PROBE_TIMEOUT_MS = 1000; // délai maximal (total) du sondage de /health
const MAX_HEALTH_BYTES = 1024; // un corps plus gros est ignoré
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
 * Pid annoncé par une réponse de `/health` : `{"ok":true,"pid":<entier >= 1>}` donne le pid ; tout le reste (JSON
 * invalide, `ok` différent de true, `pid` absent ou qui n'est pas un entier valide) donne null.
 */
function parseHealth(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.ok !== true) return null;
  return Number.isSafeInteger(value.pid) && value.pid >= 1 ? value.pid : null;
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
 * Sonde `GET /health` sur 127.0.0.1:<port> et rend le pid annoncé par un serveur de visualisation, ou null (rien
 * n'écoute, statut différent de 200, corps de plus de 1 Ko, JSON ou schéma invalide, délai dépassé).
 * Le délai `timeoutMs` borne la durée totale, y compris face à un serveur qui répond au compte-gouttes. Aucune
 * redirection n'est suivie et rien de ce qui est reçu n'est exécuté.
 * @returns {Promise<number | null>}
 */
function probeHealth(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.get({ host: HOST, port, path: "/health", agent: false }, (res) => {
      if (res.statusCode !== 200) {
        done(null);
        res.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_HEALTH_BYTES) {
          done(null);
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => done(parseHealth(Buffer.concat(chunks).toString("utf8"))));
      res.on("error", () => done(null));
      res.on("close", () => done(null));
    });
    timer = setTimeout(() => {
      done(null);
      req.destroy();
    }, timeoutMs);
    req.on("error", () => done(null));
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

/** Contenu brut du verrou, ou null s'il est illisible ou trop gros. Sert à repérer un fichier remplacé entre-temps. */
function fingerprint(lockFile) {
  try {
    if (fs.statSync(lockFile).size > MAX_LOCK_BYTES) return null;
    return fs.readFileSync(lockFile, "utf8");
  } catch {
    return null;
  }
}

/** Constat sans effet de bord : l'état, et l'empreinte du fichier sur laquelle il porte. */
async function inspect(lockFile, { isAlive, probe }) {
  if (!fs.existsSync(lockFile)) return { result: { state: "none" }, stamp: null };
  const stamp = fingerprint(lockFile);
  const lock = stamp === null ? null : parseLock(stamp);
  if (!lock) return { result: { state: "invalid", lock: null }, stamp };
  if (!isAlive(lock.pid)) return { result: { state: "stale", lock, reason: "dead" }, stamp };
  // Définition unique de « vivant » : le pid existe ET /health, sur le port du verrou, annonce ce même pid.
  const reported = await probe(lock.port);
  if (reported === lock.pid) return { result: { state: "live", lock }, stamp };
  return { result: { state: "stale", lock, reason: "unanswered" }, stamp };
}

/**
 * État du verrou, sans rien modifier. Un pid vivant ne suffit pas : `/health` doit répondre avec ce même pid.
 * @param {string} lockFile
 * @param {{ isAlive?: (pid: number) => boolean, probe?: (port: number) => Promise<number | null> }} [deps]
 *   `probe` rend le pid annoncé par `/health`, ou null
 * @returns {Promise<{ state: "none" }
 *   | { state: "live", lock: { pid: number, port: number } }
 *   | { state: "stale", lock: { pid: number, port: number }, reason: "dead" | "unanswered" }
 *   | { state: "invalid", lock: null }>}
 *   `stale` : le pid n'existe plus (`dead`), ou /health est muet, hors délai, trop gros ou annonce un autre pid
 *   (`unanswered`). `invalid` : contenu corrompu, illisible ou trop gros.
 */
async function inspectLock(lockFile, { isAlive = isPidAlive, probe = probeHealth } = {}) {
  return (await inspect(lockFile, { isAlive, probe })).result;
}

/**
 * Comme `inspectLock`, mais supprime un verrou périmé ou invalide, sauf si le fichier a changé pendant le sondage
 * (un nouveau serveur a pu prendre la place).
 */
async function checkLock(lockFile, { isAlive = isPidAlive, probe = probeHealth } = {}) {
  const { result, stamp } = await inspect(lockFile, { isAlive, probe });
  if ((result.state === "stale" || result.state === "invalid") && fingerprint(lockFile) === stamp) {
    fs.rmSync(lockFile, { force: true });
  }
  return result;
}

/**
 * Crée le verrou de façon exclusive. Un verrou dont le pid n'existe plus (ou invalide) est périmé : il est remplacé.
 * Dernier garde-fou contre deux démarrages simultanés, synchrone donc sans sondage : le pid suffit ici, car
 * `startServer` a déjà écarté (par `checkLock`) un verrou dont le pid vivant ne répond pas sur /health.
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
 * Attend jusqu'à `seconds` secondes un verrou vivant (voir `inspectLock`). Un verrou périmé n'est supprimé qu'au
 * constat final : un serveur en train de démarrer le remplace de lui-même.
 * @returns {Promise<Awaited<ReturnType<typeof inspectLock>>>}
 */
async function waitForLock(
  lockFile,
  { seconds, isAlive = isPidAlive, probe = probeHealth, sleep = sleepFor, now = Date.now, intervalMs = POLL_INTERVAL_MS } = {},
) {
  const deadline = now() + seconds * 1000;
  for (;;) {
    const result = await inspectLock(lockFile, { isAlive, probe });
    if (result.state === "live") return result;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return checkLock(lockFile, { isAlive, probe });
}

/**
 * Arrête le serveur désigné par le verrou : `process.kill` (SIGTERM), attente de la fin du processus, puis
 * suppression du verrou (sous Windows, `process.kill` termine le processus sans lui laisser nettoyer le verrou).
 * Si le processus résiste, SIGKILL, puis échec.
 *
 * Aucun signal n'est envoyé hors du cas `live` : il faut que le pid existe et que `/health` annonce ce même pid. Un
 * pid réattribué à un processus étranger, ou un faux serveur qui répond `{"ok":true}` sans le bon pid, n'est jamais
 * touché : le verrou est alors `stale` et il est supprimé.
 *
 * @returns {Promise<{ state: "none" }
 *   | { state: "stale", lock: object, reason: "dead" | "unanswered" }
 *   | { state: "invalid", lock: null }
 *   | { state: "stopped", lock: object, forced: boolean }
 *   | { state: "self" | "denied" | "survived", lock: object }>}
 *   `self` : le verrou désigne le processus courant.
 */
async function stopServer(
  lockFile,
  {
    isAlive = isPidAlive,
    probe = probeHealth,
    kill = (pid, signal) => process.kill(pid, signal),
    sleep = sleepFor,
    now = Date.now,
    selfPid = process.pid,
    timeoutMs = STOP_TIMEOUT_MS,
    killTimeoutMs = KILL_TIMEOUT_MS,
    intervalMs = STOP_POLL_MS,
  } = {},
) {
  const found = await checkLock(lockFile, { isAlive, probe });
  if (found.state !== "live") return found;
  const { lock } = found;
  if (lock.pid === selfPid) return { state: "self", lock };

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
  PROBE_TIMEOUT_MS,
  MAX_HEALTH_BYTES,
  parseLock,
  parseHealth,
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
