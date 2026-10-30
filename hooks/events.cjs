#!/usr/bin/env node
"use strict";
// Collecteur d'événements de la squad gepet (ADR 0003 et 0004).
// Déclaré en `async: true` dans hooks/hooks.json pour tous les hooks suivis : il ne ralentit jamais la session.
// Il lit le payload du hook sur stdin, le traduit en événements v1 (normalize.cjs, gh-command.cjs) et ajoute
// une ligne par événement au journal commun du repo. Hors d'un projet squad, il n'écrit rien.
//
// Garanties : code de sortie 0 quoi qu'il arrive, rien sur stdout, aucune donnée de prompt ni de rapport
// (seuls les champs extraits par normalize et gh-command sont écrits), erreurs tracées dans collector.log.

const fs = require("fs");
const { normalize } = require("./lib/normalize.cjs");
const { ghCommandToEvents } = require("./lib/gh-command.cjs");
const { isPlainObject } = require("./lib/schema.cjs");
const { locateJournal, appendEvent, appendLog, describeError } = require("./lib/journal.cjs");

const KNOWN_HOOKS = new Set(["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop"]);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Écrit une erreur dans collector.log si le projet est un projet squad. Ne lève jamais.
function trace(cwd, message) {
  try {
    const paths = locateJournal(cwd);
    if (paths !== null) appendLog(paths, message);
  } catch {
    // Rien à faire : on ne fait jamais échouer la session.
  }
}

// Événements v1 d'un payload déjà décodé. `[]` si le hook est reconnu mais sans intérêt pour la squad.
function eventsFor(payload, now) {
  if (payload.hook_event_name === "PostToolUse" && payload.tool_name === "Bash") {
    const input = payload.tool_input;
    const command = isPlainObject(input) ? input.command : undefined;
    return ghCommandToEvents(command, { now, sessionId: payload.session_id });
  }
  const event = normalize(payload, { now });
  return event === null ? [] : [event];
}

// Traite un payload brut. `fallbackCwd` sert quand le payload n'a pas de `cwd`. Ne lève jamais.
function collect(raw, fallbackCwd) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    trace(fallbackCwd, `stdin invalide : JSON illisible (${describeError(error)}, ${Buffer.byteLength(raw, "utf8")} octets)`);
    return;
  }
  const cwd = isPlainObject(payload) && typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : fallbackCwd;
  try {
    if (!isPlainObject(payload) || !KNOWN_HOOKS.has(payload.hook_event_name)) {
      trace(cwd, "payload inconnu : hook_event_name absent ou non suivi");
      return;
    }
    const events = eventsFor(payload, new Date().toISOString());
    if (events.length === 0) return;
    const paths = locateJournal(cwd);
    if (paths === null) return;
    try {
      for (const event of events) appendEvent(paths, event);
    } catch (error) {
      appendLog(paths, `écriture du journal impossible (${describeError(error)})`);
    }
  } catch (error) {
    trace(cwd, `erreur du collecteur (${describeError(error)})`);
  }
}

if (require.main === module) {
  process.on("uncaughtException", () => process.exit(0));
  collect(readStdin(), process.cwd());
  process.exitCode = 0;
}

module.exports = { collect, eventsFor };
