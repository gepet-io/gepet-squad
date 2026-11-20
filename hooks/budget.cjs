#!/usr/bin/env node
"use strict";
// Budget de contexte de la squad gepet (hook PostToolUse, synchrone).
// Chaque appel d'un agent relit tout son contexte : au-delà d'un seuil, continuer coûte plus cher que repartir
// d'un contexte neuf. Ce hook mesure le contexte du dernier appel (transcript de la session ou de l'agent) et,
// au premier franchissement du seuil, injecte une consigne dans le contexte de l'agent :
//   - développeur (et developpeur-outille) : faire un relais (agents/developpeur.md, « Relais ») ;
//   - Chef de projet (session principale qui a lancé des agents de la squad) : faire la relève au prochain point
//     calme (skills/gepet-squad/SKILL.md, « Relève du Chef de projet »).
// Seuils dans `.gepet-squad.json` : `"budget": { "developpeur": 120000, "chefDeProjet": 250000 }` (tokens ; 0
// désactive). Hors d'un projet squad, ou pour un autre agent, il ne fait rien.
//
// Garanties : code de sortie 0 quoi qu'il arrive, rien sur stdout sauf la consigne, une seule consigne par agent
// ou par session (marqueur dans `<git-common-dir>/gepet-squad/budget/`), lecture de la seule fin du transcript.

const fs = require("fs");
const path = require("path");
const { findSquadRoot, resolveCommonDir, journalPaths } = require("./lib/journal.cjs");
const { parseUsageLine } = require("../conso/lib/transcripts.cjs");

const DEFAULTS = { developpeur: 120000, chefDeProjet: 250000 };
const DEV_TYPE = /^(?:claude-)?gepet-squad:developpeur(?:-outille)?$/;
const SQUAD_TYPE = /^(?:claude-)?gepet-squad:/;
const TAIL_BYTES = 512 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Seuils effectifs : entiers positifs, 0 pour désactiver, défauts sinon. Pur. */
function thresholds(config) {
  const b = config && typeof config.budget === "object" && config.budget !== null ? config.budget : {};
  const pick = (key) => (Number.isInteger(b[key]) && b[key] >= 0 ? b[key] : DEFAULTS[key]);
  return { developpeur: pick("developpeur"), chefDeProjet: pick("chefDeProjet") };
}

/** Contexte (tokens) du dernier appel trouvé dans un texte JSONL : entrée + cache lu + cache écrit. Pur. */
function lastContext(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = parseUsageLine(lines[i], { allowSidechain: true });
    if (entry && entry.usage) return entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
  }
  return null;
}

function readTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // Première ligne probablement coupée : on l'ignore si on n'a pas lu depuis le début.
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// Dossier de la session (transcripts des agents) : `<projet>/<sessionId>/`.
function sessionDir(payload) {
  if (typeof payload.transcript_path !== "string" || !payload.transcript_path.endsWith(".jsonl")) return null;
  return payload.transcript_path.slice(0, -".jsonl".length);
}

// La session a-t-elle lancé au moins un agent de la squad ? (méta des transcripts d'agents)
function launchedSquadAgents(dir) {
  try {
    const metas = fs.readdirSync(path.join(dir, "subagents")).filter((f) => f.endsWith(".meta.json"));
    return metas.some((f) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, "subagents", f), "utf8"));
        return typeof meta.agentType === "string" && SQUAD_TYPE.test(meta.agentType);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Qui est concerné, et quel transcript lire : { role, key, transcript } ou null. Sans I/O pour un agent ;
 * pour la session principale, vérifie qu'elle a lancé des agents de la squad.
 */
function target(payload) {
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id.trim().replace(/^agent-/, "") : "";
  if (agentId !== "") {
    if (typeof payload.agent_type !== "string" || !DEV_TYPE.test(payload.agent_type) || !SAFE_ID.test(agentId)) return null;
    const dir = sessionDir(payload);
    if (dir === null) return null;
    return { role: "developpeur", key: `agent-${agentId}`, transcript: path.join(dir, "subagents", `agent-${agentId}.jsonl`) };
  }
  const dir = sessionDir(payload);
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (dir === null || !SAFE_ID.test(sessionId) || !launchedSquadAgents(dir)) return null;
  return { role: "chefDeProjet", key: `session-${sessionId}`, transcript: payload.transcript_path };
}

function message(role, ctx, max) {
  const k = (n) => `${Math.round(n / 1000)}k`;
  if (role === "developpeur") {
    return `[gepet-squad] Budget de contexte atteint : ≈${k(ctx)} tokens relus à chaque appel (seuil ${k(max)}). ` +
      "Termine l'action en cours sans en commencer d'autre, puis fais le relais décrit dans tes instructions (section « Relais ») : " +
      "commit de travail en cours, note de relais, rapport `Statut: RELAIS`. Un développeur neuf reprendra la suite.";
  }
  return `[gepet-squad] Contexte du Chef de projet ≈${k(ctx)} tokens relus à chaque appel (seuil ${k(max)}). ` +
    "Ne lance plus de nouvel agent ; dès qu'aucun agent ne tourne, fais la relève (SKILL.md de gepet-squad, « Relève du Chef de projet »).";
}

/** Consigne à injecter, ou null. Ne lève jamais. */
function evaluate(payload) {
  try {
    if (!payload || payload.hook_event_name !== "PostToolUse" || typeof payload.cwd !== "string") return null;
    const root = findSquadRoot(payload.cwd);
    if (root === null) return null;
    const who = target(payload);
    if (who === null) return null;
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(path.join(root, ".gepet-squad.json"), "utf8"));
    } catch {
      // Configuration illisible : seuils par défaut.
    }
    const max = thresholds(config)[who.role];
    if (max === 0 || !fs.existsSync(who.transcript)) return null;
    const ctx = lastContext(readTail(who.transcript));
    if (ctx === null || ctx < max) return null;

    const marks = path.join(journalPaths(resolveCommonDir(payload.cwd)).dir, "budget");
    const mark = path.join(marks, `${who.key}.json`);
    if (fs.existsSync(mark)) return null;
    fs.mkdirSync(marks, { recursive: true });
    fs.writeFileSync(mark, JSON.stringify({ ts: new Date().toISOString(), role: who.role, ctx, max }) + "\n");
    return message(who.role, ctx, max);
  } catch {
    return null;
  }
}

if (require.main === module) {
  process.on("uncaughtException", () => process.exit(0));
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = null;
  }
  const context = evaluate(payload);
  if (context !== null) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
  }
  process.exitCode = 0;
}

module.exports = { evaluate, thresholds, lastContext, target, DEFAULTS };
