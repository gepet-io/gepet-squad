#!/usr/bin/env node
// CLI de consommation (ADR 0012) : lecture seule, sans réseau ni gh.
//   node conso/cli.cjs [--project <dir>] [--milestone "<titre>=<id>,<id>…"]… [--focus "<titre>"] [--format texte|json]
// Codes de sortie : 0 succès (même sans transcript), 1 pas de projet squad, 2 arguments invalides.
"use strict";

const path = require("node:path");
const { parseArgs } = require("node:util");
const { findSquadRoot } = require("../hooks/lib/journal.cjs");
const { collectSources } = require("./lib/sources.cjs");
const { attributeCp } = require("./lib/attribution.cjs");
const { aggregate } = require("./lib/aggregate.cjs");
const { formatText, formatJson } = require("./lib/format.cjs");

const PREFIX = "[gepet-squad-conso]";
const FEATURE_ID = /^(?:[1-9]\d*|F-\d+)$/;

class UsageError extends Error {}

/** Un `--milestone "<titre>=<id>,<id>…"` ; le titre se termine au dernier « = ». Lève UsageError. */
function parseMilestone(value) {
  const cut = value.lastIndexOf("=");
  const titre = cut === -1 ? "" : value.slice(0, cut).trim();
  if (titre === "") throw new UsageError(`--milestone mal formé (attendu "<titre>=<id>,<id>…") : ${value}`);
  const rest = value.slice(cut + 1).trim();
  const issues = [];
  if (rest !== "") {
    for (const raw of rest.split(",")) {
      const id = raw.trim().replace(/^#/, "");
      if (!FEATURE_ID.test(id)) throw new UsageError(`--milestone : identifiant « ${raw.trim()} » ni entier ni F-<n> (${titre})`);
      issues.push(/^\d+$/.test(id) ? Number.parseInt(id, 10) : id);
    }
  }
  return { titre, issues };
}

/**
 * Analyse les arguments. Lève UsageError (code 2) si invalides.
 * @returns {{project: string|null, milestones: {titre: string, issues: Array<number|string>}[], focus: string|null, format: "texte"|"json"}}
 */
function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        project: { type: "string" },
        milestone: { type: "string", multiple: true },
        focus: { type: "string" },
        format: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error && error.message ? error.message : "arguments invalides");
  }
  const format = values.format === undefined ? "texte" : values.format;
  if (format !== "texte" && format !== "json") throw new UsageError(`--format doit valoir texte ou json : ${format}`);
  if (values.project !== undefined && values.project === "") throw new UsageError("--project est vide");

  const milestones = [];
  for (const value of values.milestone || []) {
    const m = parseMilestone(value);
    if (milestones.some((x) => x.titre === m.titre)) throw new UsageError(`--milestone en double : ${m.titre}`);
    milestones.push(m);
  }
  const focus = values.focus === undefined ? null : values.focus;
  if (focus !== null && !milestones.some((m) => m.titre === focus)) {
    throw new UsageError(`--focus « ${focus} » ne figure pas parmi les --milestone`);
  }
  return { project: values.project === undefined ? null : values.project, milestones, focus, format };
}

/**
 * Exécute la CLI. Ne touche ni à process.exit ni à process.stdout par défaut : renvoie le code.
 * @returns {Promise<number>}
 */
async function run(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const fail = (code, message) => {
    stderr.write(`${PREFIX} erreur ${message}\n`);
    return code;
  };
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return fail(2, error.message);
    throw error;
  }

  const root = findSquadRoot(args.project === null ? cwd : path.resolve(cwd, args.project));
  if (root === null) return fail(1, "pas de projet squad (aucun .gepet-squad.json trouvé)");

  const sources = await collectSources({ root, env });
  const milestones = args.milestones.length > 0 ? args.milestones : null;
  const table = milestones ? {} : null;
  for (const m of args.milestones) for (const id of m.issues) if (!(String(id) in table)) table[String(id)] = m.titre;

  const cp = attributeCp(sources.cpEntries, { events: sources.events, agents: sources.agents, milestones: table });
  const report = aggregate({
    project: path.basename(root),
    agents: sources.agents,
    cp: { sessions: sources.cpSessions, total: cp.total, byMilestone: cp.byMilestone },
    milestones,
    focus: args.focus,
    warnings: sources.warnings,
  });
  stdout.write(args.format === "json" ? formatJson(report) : formatText(report, { focus: args.focus }));
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${PREFIX} erreur interne ${error && error.name ? error.name : "Error"}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = { parseCliArgs, run, UsageError };
