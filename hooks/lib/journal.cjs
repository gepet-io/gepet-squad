"use strict";
// Journal d'événements local du collecteur (ADR 0003) : `<git-common-dir>/gepet-squad/events.jsonl`.
// Le dossier commun de git est partagé par le repo principal et tous ses worktrees, donc par la session
// principale et par les agents. Il n'est jamais commité.
//
// Les fonctions de calcul (journalPaths, shouldRotate, trimLog, describeError, formatLogLine) sont pures. Les
// autres touchent au disque ou lancent git, et peuvent lever : l'appelant (events.cjs) attrape tout.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MAX_JOURNAL_BYTES = 5 * 1024 * 1024; // au-delà : events.jsonl devient events.1.jsonl
const MAX_LOG_BYTES = 256 * 1024; // borne de collector.log
const CONFIG_FILE = ".gepet-squad.json";
const JOURNAL_DIR = "gepet-squad";

// Premier dossier, en remontant depuis `startDir`, qui contient `.gepet-squad.json` (même logique que
// `findConfig` dans guard.cjs). `null` hors d'un projet squad.
function findSquadRoot(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Chemins du journal pour un dossier commun de git donné. Pur.
function journalPaths(commonDir) {
  const dir = path.join(commonDir, JOURNAL_DIR);
  return {
    dir,
    events: path.join(dir, "events.jsonl"),
    rotated: path.join(dir, "events.1.jsonl"),
    log: path.join(dir, "collector.log"),
  };
}

// Dossier commun de git vu depuis `cwd` (chemin absolu). Lève si `cwd` n'est pas dans un repo git.
function resolveCommonDir(cwd) {
  const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    windowsHide: true,
  }).trim();
  if (out === "") throw new Error("git-common-dir vide");
  return path.resolve(cwd, out);
}

// Décision de rotation : vrai si ajouter `incomingBytes` octets fait dépasser `maxBytes` à un fichier non
// vide. Pur.
function shouldRotate(currentSize, incomingBytes, maxBytes = MAX_JOURNAL_BYTES) {
  return currentSize > 0 && currentSize + incomingBytes > maxBytes;
}

// Borne un texte de log à `maxBytes` octets (UTF-8) en gardant les lignes les plus récentes, entières. Pur.
function trimLog(text, maxBytes = MAX_LOG_BYTES) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const start = buffer.length - maxBytes;
  let tail = buffer.subarray(start);
  // Si la coupe tombe au milieu d'une ligne, on supprime cette ligne partielle (et donc tout octet coupé).
  if (buffer[start - 1] !== 0x0a) {
    const newline = tail.indexOf(0x0a);
    tail = newline === -1 ? Buffer.alloc(0) : tail.subarray(newline + 1);
  }
  return tail.toString("utf8");
}

// Description d'une erreur sans fuite de contenu : le message d'un JSON.parse recopie un extrait de l'entrée,
// donc on ne garde que le code (ou le nom) et l'appel système. Pur.
function describeError(error) {
  if (error === null || typeof error !== "object") return "erreur inconnue";
  const name = typeof error.code === "string" ? error.code : typeof error.name === "string" ? error.name : "Error";
  return typeof error.syscall === "string" ? `${name} (${error.syscall})` : name;
}

// Une ligne de collector.log. Pur.
function formatLogLine(date, message) {
  const flat = String(message).replace(/[\r\n]+/g, " ").slice(0, 500);
  return `${date.toISOString()} ${flat}\n`;
}

// Chemins du journal pour `cwd`, mais seulement dans un projet squad. `null` sinon, sans appeler git.
function locateJournal(cwd) {
  if (typeof cwd !== "string" || cwd === "" || findSquadRoot(cwd) === null) return null;
  return journalPaths(resolveCommonDir(cwd));
}

// Ajoute une ligne à events.jsonl, rotation comprise. `event` est un objet déjà validé.
// `options.maxBytes` permet de réduire le seuil de rotation dans les tests.
function appendEvent(paths, event, options) {
  const maxBytes = options && options.maxBytes ? options.maxBytes : MAX_JOURNAL_BYTES;
  const line = JSON.stringify(event) + "\n";
  fs.mkdirSync(paths.dir, { recursive: true });

  let size = 0;
  try {
    size = fs.statSync(paths.events).size;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (shouldRotate(size, Buffer.byteLength(line, "utf8"), maxBytes)) {
    // Un seul ancien fichier est conservé : events.1.jsonl est remplacé.
    fs.renameSync(paths.events, paths.rotated);
  }
  fs.appendFileSync(paths.events, line);
}

// Ajoute une ligne à collector.log, puis le ramène sous `maxBytes` (256 Ko par défaut).
function appendLog(paths, message, options) {
  const maxBytes = options && options.maxBytes ? options.maxBytes : MAX_LOG_BYTES;
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.appendFileSync(paths.log, formatLogLine(new Date(), message));
  if (fs.statSync(paths.log).size > maxBytes) {
    fs.writeFileSync(paths.log, trimLog(fs.readFileSync(paths.log, "utf8"), maxBytes));
  }
}

module.exports = {
  MAX_JOURNAL_BYTES,
  MAX_LOG_BYTES,
  findSquadRoot,
  journalPaths,
  resolveCommonDir,
  shouldRotate,
  trimLog,
  describeError,
  formatLogLine,
  locateJournal,
  appendEvent,
  appendLog,
};
