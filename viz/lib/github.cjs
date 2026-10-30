"use strict";
// Instantané GitHub du projet squad, obtenu par la CLI `gh` (ADR 0003 et 0005).
//
// `gh` est lancé par `execFile`, avec des arguments en tableau, SANS shell, et avec un délai maximum par appel.
// Aucun token n'est manipulé : l'authentification est celle de l'utilisateur dans `gh`.
// Le seul argument variable est le repo, validé par REPO_PATTERN avant tout appel (les noms de branches lus dans
// la configuration sont validés par BRANCH_PATTERN).
//
// Forme de l'instantané renvoyé par fetchSnapshot() :
//   {
//     repo:       "owner/nom",
//     fetchedAt:  "2026-10-30T12:00:00.000Z",           // ISO 8601 (horloge injectable)
//     issues:     [{ number, title, state, labels, status, retry, milestone, milestoneNumber }],
//     milestones: [{ number, title, state, openIssues, closedIssues, dueOn }],
//     pulls:      [{ number, title, state, head, base, url, draft, mergedAt }],
//   }
//   - `state` : "open" | "closed" pour issues et milestones ; "open" | "merged" | "closed" pour les PR.
//   - `labels` : les noms des labels. `status` : valeur du label `status:*` sans le préfixe (null s'il n'y en a pas ;
//     le premier rencontré s'il y en a plusieurs). `retry` : plus grand K des labels `retry:K` (null sinon).
//   - `milestone` : titre du milestone de l'issue (null sinon) ; `milestoneNumber` : son numéro.
//   - `pulls` : PR ouvertes, plus PR mergées vers la branche d'intégration et vers la branche de production
//     (`develop` et `main` par défaut, ou `branches` de `.gepet-squad.json`). Triées par numéro, sans doublon.
//   - Les listes sont triées par numéro croissant.
// Limites : 500 issues, 200 PR par requête, 100 milestones.
//
// Erreurs : fetchSnapshot() ne lève jamais autrement que par rejet de promesse, avec une GhError dont `code` vaut :
//   GH_MISSING  `gh` est introuvable ou n'a pas pu être lancé ;
//   GH_AUTH     `gh` s'est terminé avec un code de sortie non nul (non authentifié, accès refusé, repo inconnu…) ;
//   GH_TIMEOUT  `gh` n'a pas répondu dans le délai (15 s par appel) ;
//   GH_PARSE    la sortie de `gh` n'est pas le JSON attendu ;
//   GH_REPO     le repo est absent ou invalide (refusé avant tout appel à `gh`) ;
//   GH_CONFIG   `.gepet-squad.json` est introuvable ou illisible.
// `message` est générique et peut être affiché ; le détail brut (stderr de `gh`) est dans `detail` et ne doit aller
// que sur stderr du serveur (ADR 0005).

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { findSquadRoot } = require("../../hooks/lib/journal.cjs");

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const BRANCH_PATTERN = /^[\w][\w./-]*$/;
const CONFIG_FILE = ".gepet-squad.json";
const GH_TIMEOUT_MS = 15000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_DETAIL = 500;
const DEFAULT_BRANCHES = { integration: "develop", production: "main" };

const ISSUE_FIELDS = "number,title,state,labels,milestone";
const PULL_FIELDS = "number,title,state,headRefName,baseRefName,url,isDraft,mergedAt";

class GhError extends Error {
  /**
   * @param {"GH_MISSING"|"GH_AUTH"|"GH_TIMEOUT"|"GH_PARSE"|"GH_REPO"|"GH_CONFIG"} code
   * @param {string} message message générique, sans sortie brute de `gh`
   * @param {string} [detail] détail brut tronqué (stderr de `gh`), à réserver aux journaux du serveur
   */
  constructor(code, message, detail = "") {
    super(message);
    this.name = "GhError";
    this.code = code;
    this.detail = String(detail).trim().slice(0, MAX_DETAIL);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------------------------------------------

/**
 * Vrai si `repo` est une chaîne `owner/nom` sûre : REPO_PATTERN, et aucun des deux segments n'est `.` ou `..`
 * (le motif seul les accepterait, et `repos/../..` sortirait de l'espace du repo dans le chemin de l'API).
 */
function isValidRepo(repo) {
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) return false;
  return repo.split("/").every((segment) => segment !== "." && segment !== "..");
}

/** Lève GhError(GH_REPO) si le repo est invalide. Renvoie le repo. */
function assertValidRepo(repo) {
  if (!isValidRepo(repo)) {
    throw new GhError("GH_REPO", "Repo GitHub absent ou invalide : attendu « owner/nom ».");
  }
  return repo;
}

/** Noms des branches d'intégration et de production, avec repli sur develop et main. */
function resolveBranches(config) {
  const branches = config && typeof config === "object" ? config.branches : null;
  const pick = (value, fallback) =>
    typeof value === "string" && BRANCH_PATTERN.test(value) ? value : fallback;
  return {
    integration: pick(branches && branches.integration, DEFAULT_BRANCHES.integration),
    production: pick(branches && branches.production, DEFAULT_BRANCHES.production),
  };
}

/**
 * Les appels `gh` d'un instantané, sous forme de tableaux d'arguments (sans le nom du binaire).
 * Les arguments sont tous des éléments distincts : rien ne passe par un shell.
 * @returns {{ milestones: string[], issues: string[], pullsOpen: string[], pullsMergedIntegration: string[], pullsMergedProduction: string[] }}
 */
function buildGhCalls(repo, branches = DEFAULT_BRANCHES) {
  assertValidRepo(repo);
  const pulls = (state, base) => [
    "pr", "list", "--repo", repo, "--state", state,
    ...(base ? ["--base", base] : []),
    "--limit", "200", "--json", PULL_FIELDS,
  ];
  return {
    milestones: ["api", "-X", "GET", `repos/${repo}/milestones`, "-f", "state=all", "-f", "per_page=100"],
    issues: ["issue", "list", "--repo", repo, "--state", "all", "--limit", "500", "--json", ISSUE_FIELDS],
    pullsOpen: pulls("open"),
    pullsMergedIntegration: pulls("merged", branches.integration),
    pullsMergedProduction: pulls("merged", branches.production),
  };
}

function badShape(what) {
  return new GhError("GH_PARSE", `Réponse de gh inattendue : ${what}.`);
}

function asList(raw, what) {
  if (!Array.isArray(raw)) throw badShape(`${what} n'est pas un tableau`);
  return raw;
}

function asNumber(item, what) {
  if (!item || typeof item !== "object" || !Number.isInteger(item.number) || item.number < 1) {
    throw badShape(`${what} sans numéro valide`);
  }
  return item.number;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function lowerState(value) {
  return asString(value).toLowerCase();
}

/** Noms des labels, qu'ils soient des chaînes ou des objets `{ name }`. */
function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => (typeof label === "string" ? label : label && label.name))
    .filter((name) => typeof name === "string" && name !== "");
}

/** Valeur du premier label `status:*` (sans le préfixe), ou null. */
function statusFromLabels(names) {
  const label = names.find((name) => name.startsWith("status:") && name.length > "status:".length);
  return label ? label.slice("status:".length) : null;
}

/** Plus grand K des labels `retry:K` (entiers positifs), ou null. */
function retryFromLabels(names) {
  let retry = null;
  for (const name of names) {
    const match = /^retry:(\d+)$/.exec(name);
    if (match) {
      const value = Number(match[1]);
      if (retry === null || value > retry) retry = value;
    }
  }
  return retry;
}

/** Normalise la sortie JSON de `gh issue list --json number,title,state,labels,milestone`. */
function normalizeIssues(raw) {
  return asList(raw, "la liste des issues")
    .map((item) => {
      const number = asNumber(item, "une issue");
      const labels = labelNames(item.labels);
      const milestone = item.milestone && typeof item.milestone === "object" ? item.milestone : null;
      return {
        number,
        title: asString(item.title),
        state: lowerState(item.state),
        labels,
        status: statusFromLabels(labels),
        retry: retryFromLabels(labels),
        milestone: milestone && typeof milestone.title === "string" ? milestone.title : null,
        milestoneNumber: milestone && Number.isInteger(milestone.number) ? milestone.number : null,
      };
    })
    .sort((a, b) => a.number - b.number);
}

function countOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Normalise la sortie JSON de l'API REST `repos/<repo>/milestones`. */
function normalizeMilestones(raw) {
  return asList(raw, "la liste des milestones")
    .map((item) => {
      const number = asNumber(item, "un milestone");
      return {
        number,
        title: asString(item.title),
        state: lowerState(item.state),
        openIssues: countOf(item.open_issues),
        closedIssues: countOf(item.closed_issues),
        dueOn: typeof item.due_on === "string" ? item.due_on : null,
      };
    })
    .sort((a, b) => a.number - b.number);
}

/** Normalise la sortie JSON de `gh pr list --json …`. */
function normalizePulls(raw) {
  return asList(raw, "la liste des PR")
    .map((item) => {
      const number = asNumber(item, "une PR");
      return {
        number,
        title: asString(item.title),
        state: lowerState(item.state),
        head: asString(item.headRefName),
        base: asString(item.baseRefName),
        url: asString(item.url),
        draft: item.isDraft === true,
        mergedAt: typeof item.mergedAt === "string" && item.mergedAt !== "" ? item.mergedAt : null,
      };
    })
    .sort((a, b) => a.number - b.number);
}

/** Fusionne plusieurs listes de PR normalisées, sans doublon de numéro, triées. */
function mergePulls(...lists) {
  const byNumber = new Map();
  for (const list of lists) for (const pull of list) byNumber.set(pull.number, pull);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** Analyse du JSON produit par `gh` : GhError(GH_PARSE) si ce n'est pas du JSON. */
function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GhError("GH_PARSE", "La sortie de gh n'est pas du JSON valide.", String(stdout).slice(0, MAX_DETAIL));
  }
}

/**
 * Classe l'erreur renvoyée par `execFile` en GhError.
 * @param {NodeJS.ErrnoException & { killed?: boolean, signal?: string }} error
 * @param {string} [stderr]
 */
function classifyExecError(error, stderr = "") {
  const detail = stderr || (error && error.message) || "";
  if (error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new GhError("GH_PARSE", "La sortie de gh est trop volumineuse.", detail);
  }
  if (error && (error.killed === true || error.code === "ETIMEDOUT")) {
    return new GhError("GH_TIMEOUT", `gh n'a pas répondu en moins de ${GH_TIMEOUT_MS / 1000} s.`, detail);
  }
  if (error && typeof error.code === "number") {
    return new GhError(
      "GH_AUTH",
      `gh a échoué (code ${error.code}) : vérifier l'authentification (gh auth status) et l'accès au repo.`,
      detail,
    );
  }
  if (error && error.code === "ENOENT") {
    return new GhError("GH_MISSING", "La CLI gh est introuvable : l'installer et l'ajouter au PATH.", detail);
  }
  return new GhError("GH_MISSING", "La CLI gh n'a pas pu être lancée.", detail);
}

// ---------------------------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------------------------

/**
 * Lit `.gepet-squad.json` en remontant depuis `cwd`.
 * @returns {object} la configuration
 * @throws {GhError} GH_CONFIG si le fichier est introuvable, illisible ou n'est pas un objet JSON
 */
function readConfig(cwd) {
  const root = findSquadRoot(cwd);
  if (!root) throw new GhError("GH_CONFIG", `${CONFIG_FILE} introuvable depuis ${cwd}.`);
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("pas un objet");
    return config;
  } catch (error) {
    throw new GhError("GH_CONFIG", `${CONFIG_FILE} illisible ou invalide.`, error.message);
  }
}

/** Un appel `gh` : promesse du JSON analysé. Rejette toujours avec une GhError. */
function runGh(args, { ghBin, execFile, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        ghBin,
        args,
        {
          cwd,
          env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
          encoding: "utf8",
          windowsHide: true,
          // Jamais de shell : les arguments restent des éléments distincts (ADR 0005).
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error) return reject(classifyExecError(error, stderr));
          try {
            resolve(parseJson(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    } catch (error) {
      // execFile lève de façon synchrone pour un argument invalide (octet nul, par exemple).
      reject(classifyExecError(error));
    }
  });
}

/**
 * Prend l'instantané GitHub du projet.
 * @param {object} [options]
 * @param {string} [options.repo] `owner/nom` ; lu dans `.gepet-squad.json` (depuis `cwd`) s'il est absent
 * @param {string} [options.cwd] dossier du projet (défaut : dossier courant)
 * @param {NodeJS.ProcessEnv} [options.env] environnement de `gh` (défaut : process.env)
 * @param {number} [options.timeoutMs] délai maximum par appel (défaut : 15 000 ms)
 * @param {string} [options.ghBin] binaire à lancer (défaut : "gh")
 * @param {Function} [options.execFile] remplace child_process.execFile (tests)
 * @param {() => Date} [options.now] horloge (tests)
 * @returns {Promise<{ repo: string, fetchedAt: string, issues: object[], milestones: object[], pulls: object[] }>}
 * @throws {GhError} (rejet de la promesse) voir l'en-tête du module
 */
async function fetchSnapshot(options = {}) {
  try {
    const cwd = options.cwd || process.cwd();
    let config = null;
    if (options.repo === undefined || options.repo === null) {
      config = readConfig(cwd);
    } else {
      // Repo fourni : la configuration ne sert qu'aux noms de branches, elle reste facultative.
      try {
        config = readConfig(cwd);
      } catch {
        config = null;
      }
    }
    const repo = assertValidRepo(options.repo === undefined || options.repo === null ? config.repo : options.repo);
    const calls = buildGhCalls(repo, resolveBranches(config));

    const run = (args) =>
      runGh(args, {
        ghBin: options.ghBin || "gh",
        execFile: options.execFile || childProcess.execFile,
        cwd,
        env: options.env || process.env,
        timeoutMs: options.timeoutMs || GH_TIMEOUT_MS,
      });

    // Appels en parallèle ; en cas d'échec, l'erreur du premier appel (dans l'ordre ci-dessous) est celle qui est renvoyée.
    const results = await Promise.allSettled([
      run(calls.milestones),
      run(calls.issues),
      run(calls.pullsOpen),
      run(calls.pullsMergedIntegration),
      run(calls.pullsMergedProduction),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const [milestones, issues, pullsOpen, pullsMergedIntegration, pullsMergedProduction] = results.map(
      (result) => result.value,
    );

    const now = options.now ? options.now() : new Date();
    return {
      repo,
      fetchedAt: now.toISOString(),
      issues: normalizeIssues(issues),
      milestones: normalizeMilestones(milestones),
      pulls: mergePulls(
        normalizePulls(pullsOpen),
        normalizePulls(pullsMergedIntegration),
        normalizePulls(pullsMergedProduction),
      ),
    };
  } catch (error) {
    if (error instanceof GhError) throw error;
    throw new GhError("GH_PARSE", "Instantané GitHub impossible à construire.", error && error.message);
  }
}

module.exports = {
  REPO_PATTERN,
  GH_TIMEOUT_MS,
  GhError,
  isValidRepo,
  assertValidRepo,
  resolveBranches,
  buildGhCalls,
  normalizeIssues,
  normalizeMilestones,
  normalizePulls,
  mergePulls,
  classifyExecError,
  readConfig,
  fetchSnapshot,
};
