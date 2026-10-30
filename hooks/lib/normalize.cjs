"use strict";
// Payload de hook Claude Code -> événement v1 (ADR 0003 et 0004).
// Module pur : aucune I/O, aucune exception. Un payload sans intérêt pour la squad donne `null`.
//
// Minimisation : ni le prompt, ni `last_assistant_message`, ni `tool_input.message`, ni `content` ne sont
// recopiés. On n'extrait que MODE, ISSUE, PR et TENTATIVE du prompt, puis l'en-tête du bloc et la ligne
// `Verdict:` ou `Statut:` du rapport.

const { SCHEMA_VERSION, MAX_ID_LENGTH, isPlainObject, normalizeAgentId, validate } = require("./schema.cjs");

const SQUAD_AGENT_PREFIX = "claude-gepet-squad:";
// `Task` est l'ancien nom de l'outil `Agent`.
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const HANDBACK_TOOL = "SubagentHandback";

// En-têtes de bloc connus (skills/gepet-squad/references/report-formats.md). Liste fermée : une première
// ligne qui n'en fait pas partie n'est jamais recopiée.
const REPORT_BLOCKS = new Set([
  "QUESTIONS",
  "PROPOSITION",
  "PITCH",
  "VERDICT_ROADMAP",
  "ESCALADE",
  "RAPPORT_DEV",
  "RAPPORT_VERIFICATION",
  "RAPPORT_TESTS",
]);

function str(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_ID_LENGTH) : undefined;
}

function isSquadAgentType(value) {
  return typeof value === "string" && value.startsWith(SQUAD_AGENT_PREFIX) && value.length > SQUAD_AGENT_PREFIX.length;
}

function matchInt(text, regex) {
  const m = regex.exec(text);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

// Début d'une section libre (`Notes :`, `RAPPORT :`) : ce qui suit n'est plus de la mission.
const FREE_TEXT_START = /^[ \t]*(?:Notes?|RAPPORT)[ \t]*:/m;

// Champs de mission extraits du prompt : `MODE: …`, `ISSUE: 2`, `PR: #12`, `TENTATIVE: 1`.
// Seuls les champs en début de ligne comptent, et seule la première occurrence, avant les notes libres
// ou le rapport recopié (un correctif peut citer d'anciens `PR:` ou `ISSUE:`).
// Les verificateur et testeur n'ont pas de MODE.
function extractMission(prompt) {
  if (typeof prompt !== "string") return { mode: undefined, issue: undefined, pr: undefined, attempt: undefined };
  const cut = prompt.search(FREE_TEXT_START);
  const head = cut === -1 ? prompt : prompt.slice(0, cut);
  const mode = /^[ \t]*MODE[ \t]*:[ \t]*([A-Z][A-Z0-9_]*)/m.exec(head);
  return {
    mode: mode ? mode[1] : undefined,
    issue: matchInt(head, /^[ \t]*ISSUE[ \t]*:[ \t]*#?(\d+)/m),
    pr: matchInt(head, /^[ \t]*PR[ \t]*:[ \t]*#?(\d+)/m),
    attempt: matchInt(head, /^[ \t]*TENTATIVE[ \t]*:[ \t]*(\d+)/m),
  };
}

// Valeur d'un verdict : liste fermée (report-formats.md), pour ne jamais recopier du texte libre.
const VERDICT_VALUE = /^(PASS|FAIL|LIVRÉ|BLOQUÉ|APPROUVÉ|À REVOIR)(?![\p{L}_])/u;

function parseVerdictValue(raw) {
  const m = VERDICT_VALUE.exec(raw.replace(/^[\s*_`]+/, ""));
  return m ? m[1] : undefined;
}

// Extrait l'en-tête du bloc et le verdict d'un rapport, sans recopier d'autre texte.
function extractReport(text) {
  if (typeof text !== "string") return {};
  const lines = text.split(/\r?\n/);

  let block;
  let headerLine;
  for (const line of lines) {
    const cleaned = line.replace(/^[\s#>*_`]+/, "");
    if (cleaned === "") continue;
    const m = /^([A-Z][A-Z0-9_]*)\b/.exec(cleaned);
    if (m && REPORT_BLOCKS.has(m[1])) {
      block = m[1];
      headerLine = cleaned;
    }
    break;
  }

  let verdict;
  // `VERDICT_ROADMAP: APPROUVÉ` porte son verdict sur l'en-tête lui-même.
  if (block === "VERDICT_ROADMAP") {
    const m = /^VERDICT_ROADMAP\s*:\s*(.*)$/.exec(headerLine);
    if (m) verdict = parseVerdictValue(m[1]);
  }
  if (verdict === undefined) {
    for (const line of lines) {
      const m = /^[\s>*_`-]*(?:Verdict|Statut)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      verdict = parseVerdictValue(m[1]);
      if (verdict !== undefined) break;
    }
  }
  return { block, verdict };
}

function baseEvent(type, payload, now) {
  return {
    v: SCHEMA_VERSION,
    ts: now,
    src: "hook",
    type,
    sessionId: str(payload.session_id),
  };
}

function fromPreToolUseAgent(payload, now) {
  const input = payload.tool_input;
  if (!isPlainObject(input) || !isSquadAgentType(input.subagent_type)) return null;
  const toolUseId = str(payload.tool_use_id);
  if (toolUseId === undefined) return null;
  return {
    ...baseEvent("agent.requested", payload, now),
    toolUseId,
    agentType: str(input.subagent_type),
    ...extractMission(input.prompt),
  };
}

function fromPostToolUseAgent(payload, now) {
  const input = payload.tool_input;
  const response = payload.tool_response;
  if (!isPlainObject(input) || !isSquadAgentType(input.subagent_type) || !isPlainObject(response)) return null;
  const toolUseId = str(payload.tool_use_id);
  const agentId = normalizeAgentId(response.agentId);
  if (toolUseId === undefined || agentId === undefined) return null;

  if (response.status === "async_launched") {
    return {
      ...baseEvent("agent.launched", payload, now),
      toolUseId,
      agentId,
      agentType: str(input.subagent_type),
    };
  }
  if (response.status === "completed") {
    return {
      ...baseEvent("agent.finished", payload, now),
      toolUseId,
      agentId,
      agentType: str(input.subagent_type),
      source: "tool",
    };
  }
  return null;
}

function fromSubagentStart(payload, now) {
  const agentId = normalizeAgentId(payload.agent_id);
  if (agentId === undefined || !isSquadAgentType(payload.agent_type)) return null;
  return {
    ...baseEvent("agent.started", payload, now),
    agentId,
    agentType: str(payload.agent_type),
  };
}

function fromSubagentStop(payload, now) {
  const agentId = normalizeAgentId(payload.agent_id);
  if (agentId === undefined || !isSquadAgentType(payload.agent_type)) return null;
  // Repli du signal `agent.reported` : le verdict peut figurer dans le message de clôture.
  const { verdict } = extractReport(payload.last_assistant_message);
  return {
    ...baseEvent("agent.finished", payload, now),
    agentId,
    agentType: str(payload.agent_type),
    source: "stop",
    verdict,
  };
}

function fromHandback(payload, now) {
  const agentId = normalizeAgentId(payload.agent_id);
  const input = payload.tool_input;
  if (agentId === undefined || !isSquadAgentType(payload.agent_type)) return null;
  if (!isPlainObject(input) || typeof input.message !== "string") return null;
  const { block, verdict } = extractReport(input.message);
  return {
    ...baseEvent("agent.reported", payload, now),
    // Pas de `toolUseId` : ici c'est l'appel de SubagentHandback, alors que partout ailleurs `toolUseId`
    // désigne l'appel de l'outil Agent, clé de corrélation du réducteur (ADR 0004).
    agentId,
    agentType: str(payload.agent_type),
    block,
    verdict,
  };
}

function dispatch(payload, now) {
  const hook = payload.hook_event_name;
  const tool = payload.tool_name;
  if (hook === "PreToolUse" && AGENT_TOOLS.has(tool)) return fromPreToolUseAgent(payload, now);
  if (hook === "PostToolUse" && AGENT_TOOLS.has(tool)) return fromPostToolUseAgent(payload, now);
  if (hook === "PreToolUse" && tool === HANDBACK_TOOL) return fromHandback(payload, now);
  if (hook === "SubagentStart") return fromSubagentStart(payload, now);
  if (hook === "SubagentStop") return fromSubagentStop(payload, now);
  return null;
}

// Transforme un payload de hook (objet, ou texte JSON) en événement v1, ou `null`.
// `options.now` fixe l'horodatage (Date ou chaîne ISO), pour des tests déterministes.
function normalize(payload, options) {
  try {
    let data = payload;
    if (typeof data === "string") data = JSON.parse(data);
    if (!isPlainObject(data)) return null;

    const nowOption = options && options.now;
    const now = nowOption instanceof Date ? nowOption.toISOString() : str(nowOption) || new Date().toISOString();

    const event = dispatch(data, now);
    if (event === null) return null;
    // `undefined` n'est pas sérialisé : on le retire pour que l'objet soit identique à sa ligne JSON.
    const clean = JSON.parse(JSON.stringify(event));
    return validate(clean).valid ? clean : null;
  } catch {
    return null;
  }
}

module.exports = { normalize, extractMission, extractReport, SQUAD_AGENT_PREFIX };
