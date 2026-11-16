// Localisation et lecture en flux des sources de consommation (ADR 0012 et 0013). Lecture seule :
// aucune écriture, aucun réseau, aucun appel gh. Ne lève jamais sur une donnée inattendue : les
// anomalies sont comptées et renvoyées pour devenir des `warnings`.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { journalPaths, resolveCommonDir } = require("../../hooks/lib/journal.cjs");
const { parseUsageLine, dedupeByMessageId } = require("./transcripts.cjs");
const { attributeAgent, missionTextFromLine, roleOf } = require("./attribution.cjs");

// Un sessionId vient du journal : on n'accepte que des caractères sûrs pour un nom de fichier.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Dossier de configuration de Claude Code : CLAUDE_CONFIG_DIR, sinon ~/.claude. */
function configDir(env = process.env) {
  const value = env.CLAUDE_CONFIG_DIR;
  return typeof value === "string" && value !== "" ? value : path.join(os.homedir(), ".claude");
}

/** Slug d'un dossier projet : chaque caractère non alphanumérique devient « - ». */
function projectSlug(root) {
  return path.resolve(root).replace(/[^A-Za-z0-9]/g, "-");
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Lit un fichier JSONL en flux, ligne par ligne ; renvoie false si le fichier est illisible. */
async function eachLine(file, onLine) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) onLine(line);
    return true;
  } catch {
    if (stream) stream.destroy();
    return false;
  }
}

/**
 * Journal : `events.1.jsonl` puis `events.jsonl`, via journalPaths.
 * @returns {Promise<{events: object[], sessionIds: string[], unreadable: number, found: boolean}>}
 */
async function readJournal(root) {
  const result = { events: [], sessionIds: [], unreadable: 0, found: false };
  let paths;
  try {
    paths = journalPaths(resolveCommonDir(root));
  } catch {
    return result;
  }
  const seen = new Set();
  for (const file of [paths.rotated, paths.events]) {
    if (!isFile(file)) continue;
    result.found = true;
    await eachLine(file, (line) => {
      if (line.trim() === "") return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        result.unreadable += 1;
        return;
      }
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        result.unreadable += 1;
        return;
      }
      result.events.push(event);
      if (typeof event.sessionId === "string" && SAFE_ID.test(event.sessionId) && !seen.has(event.sessionId)) {
        seen.add(event.sessionId);
        result.sessionIds.push(event.sessionId);
      }
    });
  }
  return result;
}

/** Sous-dossiers de `<config>/projects`, sans recalculer le slug. */
function projectDirs(config) {
  const base = path.join(config, "projects");
  return listDir(base)
    .map((name) => path.join(base, name))
    .filter(isDir);
}

/** Transcripts d'agents d'une session : `<dir>/<sessionId>/subagents/agent-*.jsonl`. */
function agentFiles(sessionDir) {
  const dir = path.join(sessionDir, "subagents");
  return listDir(dir)
    .filter((name) => /^agent-.+\.jsonl$/.test(name))
    .sort()
    .map((name) => ({
      agentId: name.slice("agent-".length, -".jsonl".length),
      file: path.join(dir, name),
      metaFile: path.join(dir, name.slice(0, -".jsonl".length) + ".meta.json"),
    }));
}

/** Les sessions du journal, cherchées dans `<config>/projects/*`. Une session sans fichier est ignorée. */
function locateSessions(config, sessionIds) {
  const dirs = projectDirs(config);
  const sessions = [];
  for (const sessionId of sessionIds) {
    if (!SAFE_ID.test(sessionId)) continue;
    for (const dir of dirs) {
      const main = path.join(dir, `${sessionId}.jsonl`);
      const sessionDir = path.join(dir, sessionId);
      const hasMain = isFile(main);
      const agents = agentFiles(sessionDir);
      if (!hasMain && agents.length === 0) continue;
      sessions.push({ sessionId, main: hasMain ? main : null, agents });
      break;
    }
  }
  return sessions;
}

function readMeta(metaFile) {
  try {
    const obj = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    return obj !== null && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

/**
 * Repli sans journal : sessions de `projects/<slug>` dont au moins un `.meta.json` a un `agentType`
 * de la squad.
 */
function locateSessionsBySlug(config, root) {
  const dir = path.join(config, "projects", projectSlug(root));
  const sessions = [];
  for (const name of listDir(dir)) {
    const sessionId = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
    if (!SAFE_ID.test(sessionId) || sessions.some((s) => s.sessionId === sessionId)) continue;
    const agents = agentFiles(path.join(dir, sessionId));
    if (!agents.some((a) => roleOf(readMeta(a.metaFile).agentType) !== null)) continue;
    const main = path.join(dir, `${sessionId}.jsonl`);
    sessions.push({ sessionId, main: isFile(main) ? main : null, agents });
  }
  return sessions;
}

/**
 * Lecture en flux d'un transcript : seules les lignes contenant "usage" sont parsées.
 * @returns {Promise<{first: string, entries: object[], unreadable: number, sidechain: number}>}
 *   `entries` : réponses dédupliquées par message.id (dernière occurrence).
 */
async function readTranscript(file, { allowSidechain = false } = {}) {
  const raw = [];
  let first = "";
  let index = 0;
  let unreadable = 0;
  let sidechain = 0;
  await eachLine(file, (line) => {
    if (index++ === 0) first = line;
    if (!line.includes('"usage"')) return;
    const entry = parseUsageLine(line, { allowSidechain });
    if (entry === null) {
      try {
        JSON.parse(line);
      } catch {
        unreadable += 1;
      }
    } else if (entry.sidechain) sidechain += 1;
    else raw.push(entry);
  });
  return { first, entries: dedupeByMessageId(raw), unreadable, sidechain };
}

function sumUsage(entries) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: entries.length };
  for (const e of entries) {
    usage.input += e.usage.input;
    usage.output += e.usage.output;
    usage.cacheRead += e.usage.cacheRead;
    usage.cacheWrite += e.usage.cacheWrite;
  }
  return usage;
}

function majorityModel(entries) {
  const counts = new Map();
  for (const e of entries) counts.set(e.model, (counts.get(e.model) || 0) + 1);
  let best = null;
  for (const [model, n] of counts) if (best === null || n > best[1]) best = [model, n];
  return best ? best[0] : null;
}

function bounds(entries) {
  const times = entries.map((e) => e.ts).filter((t) => typeof t === "string" && !Number.isNaN(Date.parse(t)));
  if (times.length === 0) return { debut: null, fin: null };
  times.sort((a, b) => Date.parse(a) - Date.parse(b));
  return { debut: times[0], fin: times[times.length - 1] };
}

/**
 * Localise et lit toutes les sources d'un projet.
 * @param {{root: string, env?: object}} options
 * @returns {Promise<{events: object[], cpEntries: object[], cpSessions: number, agents: object[],
 *   warnings: {code: string, message: string}[]}>}
 *   `agents` : { agentId, role, mode, issue, pr, attempt, toolUseId, bucket, model, debut, fin, usage },
 *   prêts pour attributeCp (via toolUseId) et aggregate.
 */
async function collectSources({ root, env = process.env }) {
  const config = configDir(env);
  const journal = await readJournal(root);
  let sessions = locateSessions(config, journal.sessionIds);
  if (sessions.length === 0) sessions = locateSessionsBySlug(config, root);

  let unreadable = journal.unreadable;
  let sidechain = 0;
  const cpEntries = [];
  let cpSessions = 0;
  const agents = [];
  let files = 0;

  for (const session of sessions) {
    if (session.main) {
      files += 1;
      const t = await readTranscript(session.main);
      if (t.entries.length > 0) cpSessions += 1;
      cpEntries.push(...t.entries);
      unreadable += t.unreadable;
      sidechain += t.sidechain;
    }
    for (const a of session.agents) {
      files += 1;
      const t = await readTranscript(a.file, { allowSidechain: true });
      unreadable += t.unreadable;
      const attributed = attributeAgent({
        agentId: a.agentId,
        meta: readMeta(a.metaFile),
        missionText: missionTextFromLine(t.first),
        events: journal.events,
      });
      if (attributed === null) continue; // agent hors squad : exclu
      agents.push({
        agentId: a.agentId,
        ...attributed,
        model: majorityModel(t.entries),
        ...bounds(t.entries),
        usage: sumUsage(t.entries),
      });
    }
  }

  const warnings = [];
  if (!journal.found) {
    warnings.push({ code: "JOURNAL_ABSENT", message: "journal d'événements introuvable : attribution par les métadonnées des transcripts seulement" });
  }
  if (files === 0) {
    warnings.push({ code: "TRANSCRIPTS_ABSENTS", message: "aucun transcript trouvé (purge, autre machine ou projet jamais lancé)" });
  }
  if (unreadable > 0) warnings.push({ code: "LIGNES_ILLISIBLES", message: `${unreadable} ligne(s) illisible(s) ignorée(s)` });
  const nonAttribues = agents.filter((a) => a.bucket === "nonAttribue").length;
  if (nonAttribues > 0) warnings.push({ code: "AGENTS_NON_ATTRIBUES", message: `${nonAttribues} agent(s) de la squad sans attribution possible` });
  if (sidechain > 0) warnings.push({ code: "FORMAT_ANCIEN", message: `${sidechain} ligne(s) isSidechain dans un transcript principal ignorée(s) (ancien format de Claude Code)` });

  return { events: journal.events, cpEntries, cpSessions, agents, warnings };
}

module.exports = {
  configDir,
  projectSlug,
  readJournal,
  locateSessions,
  locateSessionsBySlug,
  readTranscript,
  collectSources,
};
