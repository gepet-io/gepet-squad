"use strict";
// Schéma d'événement v1 du journal gepet-squad (ADR 0003 et 0004).
// Module pur : aucune I/O. Contrat produit par `hooks` et lu par `viz-server`.

const SCHEMA_VERSION = 1;

// Taille maximale d'une ligne sérialisée (saut de ligne compris), en octets.
// En dessous, fs.appendFileSync est une écriture atomique (ARCHITECTURE § 6).
const MAX_LINE_BYTES = 4096;

const EVENT_TYPES = Object.freeze([
  "agent.requested",
  "agent.launched",
  "agent.started",
  "agent.reported",
  "agent.finished",
  "feature.status",
  "feature.retry",
  "pr.opened",
  "pr.merged",
  "issue.closed",
  "issue.created",
  "milestone.changed",
  "release.opened",
]);

// Valeurs possibles de `source` pour `agent.finished` : PostToolUse Agent (`tool`) ou SubagentStop (`stop`).
const FINISH_SOURCES = Object.freeze(["tool", "stop"]);

// Champs autorisés et leur type. `block`, `source` et `attempt` complètent la liste de l'ARCHITECTURE § 6
// avec les champs que l'ADR 0004 (`block`, `source`) et la minimisation (`TENTATIVE`) imposent.
//
// `attempt` : TENTATIVE d'un agent (agent.requested). `retry` : nombre d'échecs d'une feature, entier >= 1
// (feature.retry, label `retry:K`). Les deux ne se confondent pas.
//
// `ref` est toujours une chaîne, mais son sens dépend du type d'événement :
//   - pr.opened, release.opened : nom de la branche ;
//   - issue.created : titre du milestone, s'il est donné ;
//   - milestone.changed : numéro du milestone, en chaîne (`"3"`).
const FIELD_TYPES = Object.freeze({
  v: "version",
  ts: "date",
  src: "src",
  type: "type",
  sessionId: "string",
  toolUseId: "string",
  agentId: "string",
  agentType: "string",
  mode: "string",
  issue: "integer",
  pr: "integer",
  attempt: "integer",
  retry: "positive",
  status: "string",
  verdict: "string",
  label: "string",
  ref: "string",
  block: "string",
  source: "source",
});

const ALLOWED_FIELDS = Object.freeze(Object.keys(FIELD_TYPES));
const REQUIRED_FIELDS = Object.freeze(["v", "ts", "src", "type"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Longueur maximale d'un identifiant (session, outil, agent) recopié depuis un payload.
const MAX_ID_LENGTH = 200;

// Les identifiants d'agent arrivent sous deux formes (`agent-xxx` ou `xxx`) : on garde `xxx`.
function normalizeAgentId(id) {
  if (typeof id !== "string") return undefined;
  const bare = id.trim().replace(/^agent-/, "").slice(0, MAX_ID_LENGTH);
  return bare === "" ? undefined : bare;
}

// `ts` : date ISO 8601 avec fuseau (`Z` ou décalage), telle que produite par Date#toISOString.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoDate(value) {
  return typeof value === "string" && ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}

function checkField(name, value, errors) {
  switch (FIELD_TYPES[name]) {
    case "version":
      if (value !== SCHEMA_VERSION) errors.push(`v doit valoir ${SCHEMA_VERSION}`);
      break;
    case "date":
      if (!isIsoDate(value)) errors.push(`${name} doit être une date ISO 8601`);
      break;
    case "src":
      if (value !== "hook") errors.push('src doit valoir "hook"');
      break;
    case "type":
      if (!EVENT_TYPES.includes(value)) errors.push(`type inconnu : ${String(value)}`);
      break;
    case "source":
      if (!FINISH_SOURCES.includes(value)) errors.push(`source inconnue : ${String(value)}`);
      break;
    case "integer":
      if (!Number.isInteger(value) || value < 0) errors.push(`${name} doit être un entier positif ou nul`);
      break;
    case "positive":
      if (!Number.isInteger(value) || value < 1) errors.push(`${name} doit être un entier supérieur ou égal à 1`);
      break;
    case "string":
      if (typeof value !== "string" || value === "") errors.push(`${name} doit être une chaîne non vide`);
      break;
  }
}

// Vérifie un événement v1. Ne lève jamais d'exception.
// Retourne { valid, errors } ; `errors` est vide quand l'événement est conforme.
function validate(event) {
  const errors = [];
  if (!isPlainObject(event)) return { valid: false, errors: ["l'événement doit être un objet"] };

  for (const name of Object.keys(event)) {
    if (!ALLOWED_FIELDS.includes(name)) errors.push(`champ inconnu : ${name}`);
  }
  for (const name of REQUIRED_FIELDS) {
    if (event[name] === undefined) errors.push(`champ obligatoire manquant : ${name}`);
  }
  for (const name of ALLOWED_FIELDS) {
    // Un champ `undefined` disparaît à la sérialisation : il compte comme absent.
    if (event[name] !== undefined) checkField(name, event[name], errors);
  }

  if (errors.length === 0) {
    const bytes = Buffer.byteLength(JSON.stringify(event) + "\n", "utf8");
    if (bytes > MAX_LINE_BYTES) errors.push(`ligne trop longue : ${bytes} octets (maximum ${MAX_LINE_BYTES})`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  MAX_LINE_BYTES,
  EVENT_TYPES,
  FINISH_SOURCES,
  ALLOWED_FIELDS,
  REQUIRED_FIELDS,
  MAX_ID_LENGTH,
  isPlainObject,
  normalizeAgentId,
  validate,
};
