"use strict";
// Ligne de commande Bash -> événements v1 (ADR 0003 et 0004, signal 6).
// Module pur : aucune I/O, aucune exception. Après chaque rapport d'agent, le Chef de projet change le statut
// des issues et merge les PR avec `gh` : ces commandes font foi pour l'état des features entre deux recalages.
//
// Une commande peut chaîner plusieurs commandes (`&&`, `||`, `;`, `|`, `&`, retour à la ligne). Chaque segment
// est traité séparément, en respectant les guillemets, les `\` de fin de ligne, les commentaires et les
// heredocs (leur corps n'est jamais pris pour des commandes). Un segment qui n'est pas une commande `gh`
// suivie, ou dont la syntaxe est inconnue, ne produit rien.
//
// Correspondance avec le schéma (hooks/lib/schema.cjs) :
//   gh issue edit N --add-label status:X     -> feature.status     { issue, status: X }
//   gh issue edit N --add-label retry:K      -> feature.retry      { issue, attempt: K }
//   gh pr create --head feature/N-slug       -> pr.opened          { issue: N, ref: <branche> }
//   gh pr create --head release/...          -> release.opened     { ref: <branche> }
//   gh pr merge N                            -> pr.merged          { pr: N }
//   gh issue close N                         -> issue.closed       { issue: N }
//   gh issue create [--milestone M]          -> issue.created      { ref: M }
//   gh api -X PATCH repos/o/r/milestones/N   -> milestone.changed  { ref: "N", status: <state> }
// Le schéma v1 n'a pas de champ `retry` : le nombre d'échecs voyage dans `attempt`. Le numéro de la PR ou de
// l'issue créée n'est connu que dans la sortie de la commande, que le hook PostToolUse n'analyse pas.

const { SCHEMA_VERSION, MAX_ID_LENGTH, isPlainObject, validate } = require("./schema.cjs");

// Valeurs de `status:*` connues (skills/gepet-squad/references/github-conventions.md). Liste fermée.
const STATUSES = new Set([
  "backlog",
  "ready",
  "in-progress",
  "in-review",
  "in-test",
  "changes-requested",
  "blocked",
  "done",
]);

// Options de `gh issue` et `gh pr` qui prennent une valeur (forme courte -> forme longue).
// Toute autre option est considérée comme un booléen.
const GH_SHORT_VALUE_FLAGS = { R: "repo", t: "title", b: "body", F: "body-file", m: "milestone", l: "label", H: "head", B: "base", c: "comment", a: "assignee", r: "reason" };
const GH_LONG_VALUE_FLAGS = new Set([
  "repo", "title", "body", "body-file", "milestone", "label", "head", "base", "comment", "assignee", "reason",
  "add-label", "remove-label", "add-assignee", "remove-assignee", "add-project", "remove-project",
  "reviewer", "project", "template", "editor-mode",
]);

// Options de `gh api` qui prennent une valeur.
const API_SHORT_VALUE_FLAGS = { X: "method", f: "raw-field", F: "field", H: "header", q: "jq", t: "template" };
const API_LONG_VALUE_FLAGS = new Set(["method", "raw-field", "field", "header", "jq", "template", "input", "hostname", "cache", "preview"]);

// --- Découpage de la ligne de commande -------------------------------------------------------------------

// Retourne la liste des segments, chacun étant la liste de ses mots (guillemets et échappements résolus).
function splitCommandLine(input) {
  const segments = [];
  let tokens = [];
  let current = "";
  let inToken = false;
  let quote = null;
  const heredocs = [];

  const pushToken = () => {
    if (inToken) tokens.push(current);
    current = "";
    inToken = false;
  };
  const endSegment = () => {
    pushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  // Saute le corps des heredocs annoncés sur la ligne qui vient de finir ; `i` est l'index du `\n`.
  const skipHeredocBodies = (i) => {
    let pos = i;
    while (heredocs.length > 0) {
      const { word, stripTabs } = heredocs.shift();
      for (;;) {
        const start = pos + 1;
        if (start > input.length) return input.length;
        let end = input.indexOf("\n", start);
        if (end === -1) end = input.length;
        let line = input.slice(start, end).replace(/\r$/, "");
        if (stripTabs) line = line.replace(/^\t+/, "");
        pos = end;
        if (line === word || end >= input.length) break;
      }
    }
    return pos;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];

    if (quote === "'") {
      if (c === "'") quote = null;
      else current += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === "\\") {
        if (next === "\n") i += 1;
        else if (next === "\r" && input[i + 2] === "\n") i += 2;
        else if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i += 1;
        } else current += c;
      } else current += c;
      continue;
    }

    switch (c) {
      case "\\":
        if (next === "\n") i += 1;
        else if (next === "\r" && input[i + 2] === "\n") i += 2;
        else if (next !== undefined) {
          current += next;
          inToken = true;
          i += 1;
        }
        break;
      case "'":
      case '"':
        quote = c;
        inToken = true;
        break;
      case " ":
      case "\t":
      case "\r":
        pushToken();
        break;
      case "\n":
        endSegment();
        if (heredocs.length > 0) i = skipHeredocBodies(i);
        break;
      case ";":
        endSegment();
        break;
      case "|":
        if (next === "|" || next === "&") i += 1;
        endSegment();
        break;
      case "&":
        if (next === "&") {
          i += 1;
          endSegment();
        } else if (input[i - 1] === ">" || input[i - 1] === "<" || next === ">") {
          // Redirection (`2>&1`, `&>`) et non séparateur.
          current += c;
          inToken = true;
        } else endSegment();
        break;
      case "#":
        if (inToken) {
          current += c;
        } else {
          // Commentaire : jusqu'à la fin de la ligne.
          while (i + 1 < input.length && input[i + 1] !== "\n") i += 1;
        }
        break;
      case "<":
        if (next === "<" && input[i + 2] !== "<") {
          const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;|&<>()]+))/.exec(input.slice(i));
          if (m) {
            heredocs.push({ word: m[2] ?? m[3] ?? m[4], stripTabs: m[1] === "-" });
            i += m[0].length - 1;
            pushToken();
            break;
          }
        }
        current += c;
        inToken = true;
        break;
      default:
        current += c;
        inToken = true;
    }
  }
  endSegment();
  return segments;
}

// --- Analyse des arguments -------------------------------------------------------------------------------

// Sépare positionnels et options. `flags` associe le nom long de chaque option à la liste de ses valeurs
// (une option répétée en cumule plusieurs).
function parseArgs(args, shortValueFlags, longValueFlags) {
  const positionals = [];
  const flags = new Map();
  const add = (name, value) => {
    if (!flags.has(name)) flags.set(name, []);
    flags.get(name).push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      if (eq !== -1) add(arg.slice(2, eq), arg.slice(eq + 1));
      else if (longValueFlags.has(arg.slice(2)) && i + 1 < args.length) add(arg.slice(2), args[++i]);
      else add(arg.slice(2), "");
    } else if (/^-[A-Za-z]/.test(arg)) {
      const name = shortValueFlags[arg[1]];
      if (name !== undefined && arg.length > 2) add(name, arg.slice(2).replace(/^=/, ""));
      else if (name !== undefined && i + 1 < args.length) add(name, args[++i]);
      else add(arg[1], "");
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function flagValues(flags, name) {
  return flags.get(name) ?? [];
}

function lastFlag(flags, name) {
  const values = flagValues(flags, name);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

// `12`, `#12` ou l'URL d'une issue ou d'une PR -> 12.
function parseNumber(token) {
  if (typeof token !== "string") return undefined;
  const m = /^#?(\d+)$/.exec(token) ?? /\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/.exec(token);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

function firstNumber(positionals) {
  for (const p of positionals) {
    const n = parseNumber(p);
    if (n !== undefined) return n;
  }
  return undefined;
}

function shorten(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_ID_LENGTH) : undefined;
}

// Valeurs de labels : `--add-label a,b --add-label c` -> ["a", "b", "c"].
function labels(flags, name) {
  return flagValues(flags, name)
    .flatMap((value) => value.split(","))
    .map((label) => label.trim())
    .filter((label) => label !== "");
}

// --- Commandes -------------------------------------------------------------------------------------------

function issueEdit(args) {
  const { positionals, flags } = parseArgs(args, GH_SHORT_VALUE_FLAGS, GH_LONG_VALUE_FLAGS);
  const issue = firstNumber(positionals);
  if (issue === undefined) return [];
  const events = [];
  for (const label of labels(flags, "add-label")) {
    const status = /^status:(.+)$/.exec(label);
    if (status && STATUSES.has(status[1])) {
      events.push({ type: "feature.status", issue, status: status[1] });
      continue;
    }
    const retry = /^retry:(\d+)$/.exec(label);
    const attempt = retry ? Number.parseInt(retry[1], 10) : NaN;
    if (Number.isSafeInteger(attempt)) events.push({ type: "feature.retry", issue, attempt });
  }
  return events;
}

function issueClose(args) {
  const { positionals } = parseArgs(args, GH_SHORT_VALUE_FLAGS, GH_LONG_VALUE_FLAGS);
  const issue = firstNumber(positionals);
  return issue === undefined ? [] : [{ type: "issue.closed", issue }];
}

function issueCreate(args) {
  const { flags } = parseArgs(args, GH_SHORT_VALUE_FLAGS, GH_LONG_VALUE_FLAGS);
  return [{ type: "issue.created", ref: shorten(lastFlag(flags, "milestone")) }];
}

function prCreate(args) {
  const { flags } = parseArgs(args, GH_SHORT_VALUE_FLAGS, GH_LONG_VALUE_FLAGS);
  const head = shorten(lastFlag(flags, "head"));
  if (head === undefined) return [];
  // `--head owner:branche` pour une PR depuis un fork.
  const ref = shorten(head.includes(":") ? head.slice(head.indexOf(":") + 1) : head);
  if (ref === undefined) return [];
  if (ref.startsWith("release/")) return [{ type: "release.opened", ref }];
  const feature = /^feature\/(\d+)(?:-|$)/.exec(ref);
  const issue = feature ? Number.parseInt(feature[1], 10) : undefined;
  return [{ type: "pr.opened", issue: Number.isSafeInteger(issue) ? issue : undefined, ref }];
}

function prMerge(args) {
  const { positionals } = parseArgs(args, GH_SHORT_VALUE_FLAGS, GH_LONG_VALUE_FLAGS);
  const pr = firstNumber(positionals);
  return pr === undefined ? [] : [{ type: "pr.merged", pr }];
}

const MILESTONE_ENDPOINT = /^\/?repos\/[^/\s]+\/[^/\s]+\/milestones\/(\d+)\/?$/;
const MILESTONE_STATES = new Set(["open", "closed"]);

function apiCall(args) {
  const { positionals, flags } = parseArgs(args, API_SHORT_VALUE_FLAGS, API_LONG_VALUE_FLAGS);
  const method = (lastFlag(flags, "method") ?? "").toUpperCase();
  if (method !== "PATCH") return [];
  const endpoint = positionals.map((p) => MILESTONE_ENDPOINT.exec(p)).find(Boolean);
  if (!endpoint) return [];
  const fields = [...flagValues(flags, "raw-field"), ...flagValues(flags, "field")];
  const stateField = fields.map((f) => /^state=(.*)$/.exec(f)).filter(Boolean).pop();
  const state = stateField ? stateField[1] : undefined;
  return [
    {
      type: "milestone.changed",
      ref: endpoint[1],
      status: state !== undefined && MILESTONE_STATES.has(state) ? state : undefined,
    },
  ];
}

const COMMANDS = {
  issue: { edit: issueEdit, close: issueClose, create: issueCreate, new: issueCreate },
  pr: { create: prCreate, new: prCreate, merge: prMerge },
};

// Un segment -> événements partiels (sans `v`, `ts`, `src`), ou [] s'il n'est pas suivi.
function interpretSegment(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  const program = tokens[i];
  if (typeof program !== "string" || !/(?:^|[\\/])gh(?:\.exe)?$/.test(program)) return [];
  const [area, action, ...rest] = tokens.slice(i + 1);
  if (area === "api") return apiCall([action, ...rest].filter((t) => t !== undefined));
  const group = Object.hasOwn(COMMANDS, area ?? "") ? COMMANDS[area] : undefined;
  const handler = group && Object.hasOwn(group, action ?? "") ? group[action] : undefined;
  return typeof handler === "function" ? handler(rest) : [];
}

// Traduit une ligne de commande Bash en zéro, un ou plusieurs événements v1 valides, dans l'ordre d'apparition.
// `options.now` : date ISO 8601 des événements (par défaut l'instant présent) ; `options.sessionId` : session.
// Ne lève jamais d'exception : une entrée inattendue donne une liste vide.
function ghCommandToEvents(command, options) {
  try {
    if (typeof command !== "string" || command.trim() === "") return [];
    const opts = isPlainObject(options) ? options : {};
    const now = typeof opts.now === "string" ? opts.now : new Date().toISOString();
    const sessionId = shorten(opts.sessionId);
    const events = [];
    for (const tokens of splitCommandLine(command)) {
      for (const partial of interpretSegment(tokens)) {
        const full = { v: SCHEMA_VERSION, ts: now, src: "hook", sessionId, ...partial };
        // Pas de champ `undefined` : l'événement est identique avant et après sérialisation.
        const event = Object.fromEntries(Object.entries(full).filter(([, value]) => value !== undefined));
        // Un événement non conforme ne doit jamais atteindre le journal.
        if (validate(event).valid) events.push(event);
      }
    }
    return events;
  } catch {
    return [];
  }
}

module.exports = { ghCommandToEvents, splitCommandLine };
