#!/usr/bin/env node
"use strict";
// Transitions du Chef de projet en une seule commande, avec une sortie de quelques lignes.
// Chaque sous-commande remplace une suite d'appels `gh` / `git` / `Edit` que le CP enchaînait à chaque retour
// d'agent : moins de tours pour le CP, et rien de volumineux dans son contexte (pas de JSON d'issues).
//
//   node squad.cjs etat [--milestone "<titre>"]
//       état compact du milestone (courant par défaut) : une ligne par feature, puis les features prêtes
//   node squad.cjs statut <id> <statut> [--retry <k>]
//       pose le statut (et le compteur de retries) en une fois ; `done` et `--retry 0` retirent les retries
//   node squad.cjs merge <id> [--pr <n>] [--sha <commit vérifié>] [--message "<type>(<scope>): <titre>"] [--pr-repo <owner/repo>]
//       merge squash sur develop, statut done, fermeture, débloque les features dont les dépendances sont
//       mergées, commit (et push en hybride) des rapports ; refuse si la PR a reçu des commits après `--sha`
//
// Modes (`.gepet-squad.json`) : normal et économe hybride passent par `gh` (labels, issues, PR) ; économe local
// modifie `docs/squad/etat.md` et merge en local, sans jamais appeler `gh` ni pousser.
// Les règles du garde-fou (hooks/guard.cjs) sont appliquées ici aussi, puisqu'il ne voit que `node squad.cjs` :
// jamais de merge vers `main`, jamais de push ni de `gh` en économe local.
// Les commandes `gh` exécutées sont journalisées comme si le CP les avait lancées (vue /gepet-squad-viz).
//
// Codes de sortie : 0 OK ; 1 erreur ; 2 usage ; 3 refus (nouveaux commits, conflit, branche inattendue).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const STATUSES = ["backlog", "ready", "in-progress", "in-review", "in-test", "changes-requested", "blocked", "done"];
const MAX_RETRY = 9;

class SquadError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// --- Fonctions pures (testées unitairement) -----------------------------------------------------------------

/** Options `--nom valeur` et positionnels. Lève SquadError(2) sur une option sans valeur. */
function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new SquadError(`option ${a} sans valeur`, 2);
      options[a.slice(2)] = value;
      i += 1;
    } else positionals.push(a);
  }
  return { positionals, options };
}

/** "normal" | "local" | "hybride". */
function modeOf(config) {
  if (!config || config.mode !== "econome") return "normal";
  return config.suivi === "hybride" ? "hybride" : "local";
}

function checkStatus(status) {
  if (!STATUSES.includes(status)) throw new SquadError(`statut inconnu : ${status} (${STATUSES.join(", ")})`, 2);
}

function checkRetry(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RETRY) throw new SquadError(`--retry invalide : ${value}`, 2);
  return n;
}

/**
 * Arguments de `gh issue edit` pour une transition : retire tous les autres `status:*` (et `retry:*` si le
 * compteur change), ajoute les nouveaux. Pas besoin de connaître l'état précédent.
 */
function labelEditArgs(issue, repo, status, retry) {
  checkStatus(status);
  const effectiveRetry = status === "done" ? 0 : retry;
  const remove = STATUSES.filter((s) => s !== status).map((s) => `status:${s}`);
  const add = [`status:${status}`];
  if (effectiveRetry !== undefined) {
    for (let k = 1; k <= 3; k += 1) if (k !== effectiveRetry) remove.push(`retry:${k}`);
    if (effectiveRetry > 0) add.push(`retry:${effectiveRetry}`);
  }
  return ["issue", "edit", String(issue), "--repo", repo, "--remove-label", remove.join(","), "--add-label", add.join(",")];
}

/** Dépendances `#n` de la section « ## Dépendances » d'un corps d'issue. */
function depsFromBody(body) {
  if (typeof body !== "string") return [];
  const m = /^##\s*Dépendances\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body);
  if (!m) return [];
  return [...new Set([...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1])))];
}

/** Dépendances `F-xx` d'une cellule de etat.md. */
function depsFromCell(cell) {
  return [...new Set(String(cell || "").match(/F-\d+/g) || [])];
}

// Découpe une ligne de table Markdown en cellules (sans les bords).
function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/**
 * Lit la table « Features » de etat.md : { lines, header, cols, rows: [{ index, cells, id }] }.
 * `cols` associe un nom de colonne (Feature, Statut, Retry, Dépendances, Branche, Milestone…) à son index.
 */
function parseEtat(text) {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => /^\|\s*Feature\s*\|/.test(l));
  if (headerIndex === -1) throw new SquadError("etat.md : table « Features » introuvable");
  const header = cells(lines[headerIndex]);
  const cols = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const needed of ["Feature", "Statut", "Retry"]) {
    if (!(needed in cols)) throw new SquadError(`etat.md : colonne « ${needed} » absente`);
  }
  const rows = [];
  for (let i = headerIndex + 2; i < lines.length && lines[i].trim().startsWith("|"); i += 1) {
    const c = cells(lines[i]);
    if (/^F-\d+$/.test(c[cols.Feature])) rows.push({ index: i, cells: c, id: c[cols.Feature] });
  }
  return { lines, cols, rows, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function rowToLine(c) {
  return `| ${c.join(" | ")} |`;
}

function findRow(etat, id) {
  const row = etat.rows.find((r) => r.id === id);
  if (!row) throw new SquadError(`${id} absente de etat.md`);
  return row;
}

/** Modifie la ligne d'une feature (statut, retry) ; renvoie le texte complet. */
function setRowStatus(etat, id, status, retry) {
  checkStatus(status);
  const row = findRow(etat, id);
  row.cells[etat.cols.Statut] = status;
  const effectiveRetry = status === "done" ? 0 : retry;
  if (effectiveRetry !== undefined) row.cells[etat.cols.Retry] = String(effectiveRetry);
  etat.lines[row.index] = rowToLine(row.cells);
  return etat.lines.join(etat.eol);
}

/**
 * Features à débloquer : statut `backlog` et toutes les dépendances `done` (identifiants dans `doneIds`).
 * `items` : [{ id, status, deps }]. Renvoie les ids, dans l'ordre.
 */
function unblockable(items, doneIds) {
  const done = new Set(doneIds);
  return items.filter((it) => it.status === "backlog" && it.deps.every((d) => done.has(d))).map((it) => it.id);
}

/** Features prêtes : statut `ready` et dépendances toutes `done`. */
function readyList(items, doneIds) {
  const done = new Set(doneIds);
  return items.filter((it) => it.status === "ready" && it.deps.every((d) => done.has(d))).map((it) => it.id);
}

/** Statut et retry d'une issue à partir de ses labels. */
function labelsState(labels) {
  const names = (labels || []).map((l) => (typeof l === "string" ? l : l && l.name)).filter(Boolean);
  const status = names.find((n) => n.startsWith("status:"));
  const retry = names.find((n) => /^retry:\d+$/.test(n));
  return { status: status ? status.slice(7) : "?", retry: retry ? Number(retry.slice(6)) : 0 };
}

/** Ligne de commande lisible (pour le journal d'événements), avec guillemets si besoin. */
function commandLine(program, args) {
  return [program, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${String(a).replace(/(["\\$`])/g, "\\$1")}"`)).join(" ");
}

// --- Entrées / sorties ---------------------------------------------------------------------------------------

function findRoot(start) {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".gepet-squad.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new SquadError(".gepet-squad.json introuvable : lance cette commande dans un projet squad");
    current = parent;
  }
}

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  } catch (error) {
    if (allowFail) return null;
    const detail = String(error.stderr || error.message).trim().split("\n").slice(-3).join(" ");
    throw new SquadError(`git ${args.join(" ")} : ${detail}`);
  }
}

// `gh`, ou un faux gh en JavaScript pour les tests (GEPET_GH_SCRIPT : chemin d'un script node).
function runGh(cwd, args) {
  const script = process.env.GEPET_GH_SCRIPT;
  const [file, fileArgs] = script ? [process.execPath, [script, ...args]] : ["gh", args];
  try {
    return execFileSync(file, fileArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split("\n").slice(-3).join(" ");
    throw new SquadError(`gh ${args.slice(0, 3).join(" ")} : ${detail}`);
  }
}

// Journalise une commande gh comme le ferait le collecteur PostToolUse. Ne lève jamais.
function journal(cwd, args) {
  try {
    const { ghCommandToEvents } = require("../hooks/lib/gh-command.cjs");
    const { locateJournal, appendEvent } = require("../hooks/lib/journal.cjs");
    const paths = locateJournal(cwd);
    if (paths === null) return;
    for (const event of ghCommandToEvents(commandLine("gh", args), {})) appendEvent(paths, event);
  } catch {
    // Le journal n'est qu'un confort pour la vue : il ne bloque jamais une transition.
  }
}

function ghWrite(ctx, args) {
  const out = runGh(ctx.root, args);
  journal(ctx.root, args);
  return out;
}

function context(cwd) {
  const root = findRoot(cwd);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(root, ".gepet-squad.json"), "utf8"));
  } catch {
    throw new SquadError(".gepet-squad.json illisible");
  }
  const mode = modeOf(config);
  const integration = (config.branches && config.branches.integration) || "develop";
  const production = (config.branches && config.branches.production) || "main";
  return { root, config, mode, repo: config.repo, integration, production, etatPath: path.join(root, "docs", "squad", "etat.md") };
}

function requireRepo(ctx) {
  if (typeof ctx.repo !== "string" || !ctx.repo.includes("/")) throw new SquadError("`repo` (owner/nom) absent de .gepet-squad.json");
}

function readEtat(ctx) {
  if (!fs.existsSync(ctx.etatPath)) throw new SquadError("docs/squad/etat.md introuvable");
  return parseEtat(fs.readFileSync(ctx.etatPath, "utf8"));
}

function etatItems(etat) {
  const depCol = etat.cols["Dépendances"];
  return etat.rows.map((r) => ({
    id: r.id,
    status: r.cells[etat.cols.Statut],
    retry: Number(r.cells[etat.cols.Retry]) || 0,
    deps: depCol === undefined ? [] : depsFromCell(r.cells[depCol]),
    milestone: etat.cols.Milestone === undefined ? "" : r.cells[etat.cols.Milestone],
    title: etat.cols.Titre === undefined ? "" : r.cells[etat.cols.Titre],
  }));
}

// Issues du repo, avec statut et dépendances. Une seule lecture `gh issue list`.
function ghItems(ctx) {
  const raw = runGh(ctx.root, ["issue", "list", "--repo", ctx.repo, "--state", "all", "--limit", "500", "--json", "number,title,state,labels,milestone,body"]);
  let list;
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    throw new SquadError("gh issue list : réponse illisible");
  }
  return list.map((i) => {
    const { status, retry } = labelsState(i.labels);
    return {
      id: i.number,
      closed: String(i.state).toUpperCase() === "CLOSED",
      status,
      retry,
      deps: depsFromBody(i.body),
      milestone: i.milestone ? i.milestone.title : "",
      milestoneNumber: i.milestone ? i.milestone.number : Infinity,
      title: i.title || "",
    };
  });
}

function short(text, n = 60) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function label(ctx, id) {
  return ctx.mode === "local" ? id : `#${id}`;
}

// --- Sous-commandes ------------------------------------------------------------------------------------------

function cmdEtat(ctx, { options }) {
  let items;
  let doneIds;
  if (ctx.mode === "local") {
    items = etatItems(readEtat(ctx));
    doneIds = items.filter((i) => i.status === "done").map((i) => i.id);
  } else {
    requireRepo(ctx);
    items = ghItems(ctx);
    doneIds = items.filter((i) => i.closed).map((i) => i.id);
  }
  let milestone = options.milestone;
  if (milestone === undefined) {
    const open = items.filter((i) => i.status !== "done" && !i.closed);
    if (ctx.mode !== "local") open.sort((a, b) => a.milestoneNumber - b.milestoneNumber);
    milestone = open.length > 0 ? open[0].milestone : "";
  }
  const scoped = items.filter((i) => i.milestone === milestone);
  const out = [`Milestone : ${milestone || "(aucun ouvert)"}`];
  for (const i of scoped) {
    const deps = i.deps.length ? i.deps.map((d) => label(ctx, d)).join(",") : "aucune";
    out.push(`${label(ctx, i.id)} ${i.status} r${i.retry} deps:${deps} — ${short(i.title)}`);
  }
  const ready = readyList(scoped.filter((i) => !i.closed), doneIds);
  const toUnblock = unblockable(scoped.filter((i) => !i.closed), doneIds);
  out.push(`Prêtes : ${ready.map((id) => label(ctx, id)).join(", ") || "aucune"}`);
  if (toUnblock.length) out.push(`À débloquer (backlog, dépendances mergées) : ${toUnblock.map((id) => label(ctx, id)).join(", ")}`);
  const open = scoped.filter((i) => i.status !== "done" && !i.closed).length;
  out.push(open === 0 && scoped.length > 0 ? "Milestone terminé : passe à la release (phase 5)." : `${open} feature(s) ouverte(s).`);
  return out.join("\n");
}

function parseId(ctx, raw) {
  if (ctx.mode === "local") {
    if (!/^F-\d+$/.test(raw || "")) throw new SquadError(`identifiant attendu : F-xx (reçu ${raw})`, 2);
    return raw;
  }
  const n = Number(String(raw || "").replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new SquadError(`numéro d'issue attendu (reçu ${raw})`, 2);
  return n;
}

function cmdStatut(ctx, { positionals, options }) {
  const [rawId, status] = positionals;
  if (status === undefined) throw new SquadError("usage : statut <id> <statut> [--retry <k>]", 2);
  const id = parseId(ctx, rawId);
  checkStatus(status);
  const retry = checkRetry(options.retry);
  if (ctx.mode === "local") {
    const etat = readEtat(ctx);
    const before = findRow(etat, id).cells[etat.cols.Statut];
    fs.writeFileSync(ctx.etatPath, setRowStatus(etat, id, status, retry));
    return `${id} : ${before} → ${status}${retry !== undefined ? ` (retry ${status === "done" ? 0 : retry})` : ""}`;
  }
  requireRepo(ctx);
  ghWrite(ctx, labelEditArgs(id, ctx.repo, status, retry));
  return `#${id} : status:${status}${retry !== undefined ? ` (retry ${status === "done" ? 0 : retry})` : ""}`;
}

function onIntegration(ctx) {
  const branch = git(ctx.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === ctx.production) throw new SquadError(`branche courante ${branch} : jamais de merge sur ${ctx.production}`, 3);
  if (branch !== ctx.integration) throw new SquadError(`branche courante ${branch} : place-toi sur ${ctx.integration}`, 3);
}

function mergeLocal(ctx, id, options) {
  onIntegration(ctx);
  const etat = readEtat(ctx);
  const row = findRow(etat, id);
  const brCol = etat.cols.Branche;
  let branch = brCol === undefined ? "" : row.cells[brCol];
  if (!branch || branch === "—" || branch === "-") {
    const found = git(ctx.root, ["branch", "--list", `feature/${id}-*`, "--format=%(refname:short)"]).split("\n").filter(Boolean);
    if (found.length !== 1) throw new SquadError(`branche de ${id} introuvable ou ambiguë (${found.join(", ") || "aucune"})`, 3);
    branch = found[0];
  }
  const title = etat.cols.Titre === undefined ? id : row.cells[etat.cols.Titre];
  const scope = etat.cols.Scope === undefined ? "" : row.cells[etat.cols.Scope];
  const message = options.message || `feat${scope ? `(${scope})` : ""}: ${title} (${id})`;

  if (git(ctx.root, ["merge", "--squash", branch], { allowFail: true }) === null) {
    git(ctx.root, ["reset", "--merge"], { allowFail: true });
    throw new SquadError(`conflit en fusionnant ${branch} : merge annulé, correctif du développeur (rebase sur ${ctx.integration})`, 3);
  }
  git(ctx.root, ["commit", "-q", "-m", message]);
  git(ctx.root, ["branch", "-D", branch]);

  // Statut done, puis déblocage, sur le texte relu après le merge (le merge ne touche pas docs/squad).
  const after = readEtat(ctx);
  let text = setRowStatus(after, id, "done", 0);
  const items = etatItems(parseEtat(text));
  const doneIds = items.filter((i) => i.status === "done").map((i) => i.id);
  const unblocked = unblockable(items, doneIds);
  for (const u of unblocked) text = setRowStatus(parseEtat(text), u, "ready");
  fs.writeFileSync(ctx.etatPath, text);
  const toAdd = ["docs/squad"];
  if (fs.existsSync(path.join(ctx.root, "docs", "roadmap.md"))) toAdd.push("docs/roadmap.md");
  git(ctx.root, ["add", ...toAdd]);
  git(ctx.root, ["commit", "-q", "-m", `docs(squad): ${id} mergée`], { allowFail: true });
  return { branch, message, unblocked };
}

function mergeGithub(ctx, id, options) {
  requireRepo(ctx);
  const pr = Number(String(options.pr || "").replace(/^#/, ""));
  if (!Number.isInteger(pr) || pr <= 0) throw new SquadError("merge : --pr <n> obligatoire hors mode économe local", 2);
  const prRepo = options["pr-repo"] || ctx.repo;
  const view = JSON.parse(runGh(ctx.root, ["pr", "view", String(pr), "--repo", prRepo, "--json", "headRefOid,baseRefName,state"]) || "{}");
  if (view.baseRefName !== ctx.integration) throw new SquadError(`PR #${pr} vers ${view.baseRefName} : seul un merge vers ${ctx.integration} est permis`, 3);
  if (options.sha && view.headRefOid && !view.headRefOid.startsWith(options.sha) && !options.sha.startsWith(view.headRefOid)) {
    throw new SquadError(`PR #${pr} : nouveaux commits depuis ${options.sha.slice(0, 7)} (tête ${String(view.headRefOid).slice(0, 7)}) : relance la vérification`, 3);
  }
  if (String(view.state).toUpperCase() !== "MERGED") ghWrite(ctx, ["pr", "merge", String(pr), "--repo", prRepo, "--squash", "--delete-branch"]);
  ghWrite(ctx, labelEditArgs(id, ctx.repo, "done", 0));
  ghWrite(ctx, ["issue", "close", String(id), "--repo", ctx.repo, "--comment", `Mergée sur ${ctx.integration} via #${pr}`]);

  const notes = [];
  const branch = git(ctx.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === ctx.integration) {
    if (git(ctx.root, ["pull", "-q", "--ff-only"], { allowFail: true }) === null) notes.push(`git pull sur ${ctx.integration} impossible : à faire à la main`);
    if (ctx.mode === "hybride" && fs.existsSync(path.join(ctx.root, "docs", "squad"))) {
      git(ctx.root, ["add", "docs/squad"]);
      if (git(ctx.root, ["diff", "--cached", "--quiet"], { allowFail: true }) === null) {
        git(ctx.root, ["commit", "-q", "-m", `docs(squad): rapports de #${id}`]);
        if (git(ctx.root, ["push", "-q", "origin", ctx.integration], { allowFail: true }) === null) notes.push("push des rapports impossible : à faire à la main");
      }
    }
  } else notes.push(`branche courante ${branch} : pull et rapports non traités (place-toi sur ${ctx.integration})`);

  const items = ghItems(ctx).map((i) => (i.id === id ? { ...i, closed: true, status: "done" } : i));
  const doneIds = items.filter((i) => i.closed).map((i) => i.id);
  const unblocked = unblockable(items.filter((i) => !i.closed), doneIds);
  for (const u of unblocked) ghWrite(ctx, labelEditArgs(u, ctx.repo, "ready"));
  return { branch: `PR #${pr}`, message: "squash", unblocked, notes };
}

function cmdMerge(ctx, { positionals, options }) {
  const id = parseId(ctx, positionals[0]);
  const res = ctx.mode === "local" ? mergeLocal(ctx, id, options) : mergeGithub(ctx, id, options);
  const lines = [`${label(ctx, id)} mergée sur ${ctx.integration} (${res.branch}) et passée en done.`];
  lines.push(`Débloquées (backlog → ready) : ${res.unblocked.map((u) => label(ctx, u)).join(", ") || "aucune"}`);
  for (const n of res.notes || []) lines.push(`Attention : ${n}`);
  return lines.join("\n");
}

const COMMANDS = { etat: cmdEtat, statut: cmdStatut, merge: cmdMerge };

function main(argv, cwd = process.cwd()) {
  const [name, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, name || "")) throw new SquadError("usage : node squad.cjs etat|statut|merge …", 2);
  const ctx = context(cwd);
  return COMMANDS[name](ctx, parseArgs(rest));
}

if (require.main === module) {
  try {
    process.stdout.write(main(process.argv.slice(2)) + "\n");
  } catch (error) {
    process.stderr.write(`squad : ${error.message}\n`);
    process.exitCode = error instanceof SquadError ? error.code : 1;
  }
}

module.exports = {
  STATUSES,
  SquadError,
  parseArgs,
  modeOf,
  labelEditArgs,
  depsFromBody,
  depsFromCell,
  parseEtat,
  setRowStatus,
  unblockable,
  readyList,
  labelsState,
  commandLine,
  main,
};
