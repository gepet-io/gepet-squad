// Tests de viz/lib/github.cjs : fonctions pures (unitaires), puis fetchSnapshot avec le faux `gh` (intégration).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const github = require("../../viz/lib/github.cjs");
const { installFakeGh } = require("../helpers/index.cjs");

const {
  GhError,
  GH_TIMEOUT_MS,
  isValidRepo,
  resolveBranches,
  buildGhCalls,
  normalizeIssues,
  normalizeMilestones,
  normalizePulls,
  mergePulls,
  classifyExecError,
  readConfig,
  fetchSnapshot,
} = github;

const FIXTURES = path.join(__dirname, "..", "fixtures", "gh-json");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const FIXED_NOW = () => new Date("2026-10-30T12:00:00.000Z");

// ---------------------------------------------------------------------------------------------------------------
// Unitaires
// ---------------------------------------------------------------------------------------------------------------

describe("validation du repo (unitaire)", () => {
  test("accepte owner/nom", () => {
    for (const repo of ["o/r", "gepets/claude-gepet-squad", "a.b/c_d-e.f", "Owner1/Repo.js"]) {
      assert.equal(isValidRepo(repo), true, repo);
    }
  });

  test("refuse tout ce qui n'est pas owner/nom", () => {
    const invalides = [
      "",
      "o",
      "o/",
      "/r",
      "o/r/x",
      "o r/x",
      "o/r x",
      "o/r;rm -rf /",
      "o/r && calc",
      "o/r\n",
      "o/r\nx/y",
      "$(whoami)/r",
      "o/`id`",
      "o/r|cat",
      "o\\r",
      "https://github.com/o/r",
      "o/r?x=1",
      "o/é",
      "../..",
      "./.",
      "o/..",
      "../r",
      undefined,
      null,
      42,
      {},
      ["o/r"],
    ];
    for (const repo of invalides) {
      assert.equal(isValidRepo(repo), false, JSON.stringify(repo));
    }
  });
});

describe("buildGhCalls (unitaire)", () => {
  test("construit les cinq appels, sous forme de tableaux d'arguments", () => {
    assert.deepEqual(buildGhCalls("o/r"), {
      milestones: ["api", "-X", "GET", "repos/o/r/milestones", "-f", "state=all", "-f", "per_page=100"],
      issues: [
        "issue", "list", "--repo", "o/r", "--state", "all", "--limit", "500",
        "--json", "number,title,state,labels,milestone",
      ],
      pullsOpen: [
        "pr", "list", "--repo", "o/r", "--state", "open", "--limit", "200",
        "--json", "number,title,state,headRefName,baseRefName,url,isDraft,mergedAt",
      ],
      pullsMergedIntegration: [
        "pr", "list", "--repo", "o/r", "--state", "merged", "--base", "develop", "--limit", "200",
        "--json", "number,title,state,headRefName,baseRefName,url,isDraft,mergedAt",
      ],
      pullsMergedProduction: [
        "pr", "list", "--repo", "o/r", "--state", "merged", "--base", "main", "--limit", "200",
        "--json", "number,title,state,headRefName,baseRefName,url,isDraft,mergedAt",
      ],
    });
  });

  test("utilise les branches données", () => {
    const calls = buildGhCalls("o/r", { integration: "dev", production: "master" });
    assert.deepEqual(calls.pullsMergedIntegration.slice(4, 8), ["--state", "merged", "--base", "dev"]);
    assert.deepEqual(calls.pullsMergedProduction.slice(4, 8), ["--state", "merged", "--base", "master"]);
  });

  test("refuse un repo invalide", () => {
    assert.throws(() => buildGhCalls("o/r;x"), { code: "GH_REPO" });
  });
});

describe("resolveBranches (unitaire)", () => {
  test("lit integration et production, avec repli sur develop et main", () => {
    assert.deepEqual(resolveBranches({ branches: { integration: "dev", production: "prod" } }), {
      integration: "dev",
      production: "prod",
    });
    assert.deepEqual(resolveBranches(null), { integration: "develop", production: "main" });
    assert.deepEqual(resolveBranches({}), { integration: "develop", production: "main" });
  });

  test("ignore un nom de branche suspect", () => {
    const branches = resolveBranches({ branches: { integration: "--delete", production: "a b;c" } });
    assert.deepEqual(branches, { integration: "develop", production: "main" });
  });
});

describe("normalizeIssues (unitaire)", () => {
  test("normalise la fixture : états en minuscules, labels, status, retry, milestone, tri par numéro", () => {
    const issues = normalizeIssues(fixture("issues.json"));
    assert.deepEqual(issues, fixture("expected-snapshot.json").issues);
    assert.deepEqual(issues.map((i) => i.number), [3, 12, 20]);
  });

  test("retient le plus grand retry et ignore les labels retry mal formés", () => {
    const [issue] = normalizeIssues([
      { number: 1, labels: ["retry:1", "retry:3", "retry:x", "retry:", "retry:-2", "retry:2"] },
    ]);
    assert.equal(issue.retry, 3);
  });

  test("status : premier label status:* non vide, null sinon", () => {
    const status = (labels) => normalizeIssues([{ number: 1, labels }])[0].status;
    assert.equal(status(["status:blocked", "status:done"]), "blocked");
    assert.equal(status(["status:"]), null);
    assert.equal(status(["scope:x", "statusquo"]), null);
    assert.equal(status(undefined), null);
  });

  test("tolère titre, labels et milestone absents ou de type inattendu", () => {
    const [issue] = normalizeIssues([{ number: 7, title: 5, state: null, labels: "x", milestone: "M1" }]);
    assert.deepEqual(issue, {
      number: 7,
      title: "",
      state: "",
      labels: [],
      status: null,
      retry: null,
      milestone: null,
      milestoneNumber: null,
    });
  });

  test("rejette (GH_PARSE) un non-tableau et une issue sans numéro valide", () => {
    for (const raw of [{}, null, "x", 3]) {
      assert.throws(() => normalizeIssues(raw), { code: "GH_PARSE" });
    }
    for (const item of [{}, { number: "12" }, { number: 0 }, { number: 1.5 }, null, "x"]) {
      assert.throws(() => normalizeIssues([item]), { code: "GH_PARSE" });
    }
  });
});

describe("normalizeMilestones (unitaire)", () => {
  test("normalise la réponse REST de la fixture, triée par numéro", () => {
    const milestones = normalizeMilestones(fixture("milestones.json"));
    assert.deepEqual(milestones, fixture("expected-snapshot.json").milestones);
    assert.deepEqual(milestones.map((m) => m.number), [1, 2]);
  });

  test("compteurs invalides ramenés à 0, échéance invalide à null", () => {
    const [m] = normalizeMilestones([{ number: 1, title: "M", state: "OPEN", open_issues: "3", closed_issues: -1, due_on: 5 }]);
    assert.equal(m.state, "open");
    assert.equal(m.openIssues, 0);
    assert.equal(m.closedIssues, 0);
    assert.equal(m.dueOn, null);
  });

  test("rejette (GH_PARSE) un non-tableau et un milestone sans numéro", () => {
    assert.throws(() => normalizeMilestones({ message: "Not Found" }), { code: "GH_PARSE" });
    assert.throws(() => normalizeMilestones([{ title: "M" }]), { code: "GH_PARSE" });
  });
});

describe("normalizePulls et mergePulls (unitaire)", () => {
  test("normalise une PR ouverte brouillon et une PR mergée", () => {
    const [ouverte] = normalizePulls(fixture("pulls-open.json"));
    assert.deepEqual(ouverte, {
      number: 40,
      title: "feat(viz-server): instantané GitHub",
      state: "open",
      head: "feature/12-instantane-github",
      base: "develop",
      url: "https://github.com/o/r/pull/40",
      draft: true,
      mergedAt: null,
    });
    const [mergee] = normalizePulls(fixture("pulls-merged-main.json"));
    assert.equal(mergee.state, "merged");
    assert.equal(mergee.base, "main");
    assert.equal(mergee.mergedAt, "2026-10-28T10:00:00Z");
  });

  test("mergePulls supprime les doublons de numéro et trie", () => {
    const merged = mergePulls(
      normalizePulls([{ number: 5, title: "a" }, { number: 2, title: "b" }]),
      normalizePulls([{ number: 5, title: "a bis" }, { number: 9, title: "c" }]),
    );
    assert.deepEqual(merged.map((p) => [p.number, p.title]), [[2, "b"], [5, "a bis"], [9, "c"]]);
  });

  test("rejette (GH_PARSE) un non-tableau et une PR sans numéro", () => {
    assert.throws(() => normalizePulls({}), { code: "GH_PARSE" });
    assert.throws(() => normalizePulls([{ title: "x" }]), { code: "GH_PARSE" });
  });
});

describe("classifyExecError (unitaire)", () => {
  test("ENOENT -> GH_MISSING", () => {
    assert.equal(classifyExecError(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })).code, "GH_MISSING");
  });

  test("processus tué -> GH_TIMEOUT", () => {
    assert.equal(classifyExecError(Object.assign(new Error("x"), { killed: true, signal: "SIGTERM", code: null })).code, "GH_TIMEOUT");
  });

  test("code de sortie non nul -> GH_AUTH, avec le stderr en détail mais pas dans le message", () => {
    const error = classifyExecError(Object.assign(new Error("Command failed"), { code: 4 }), "To get started with GitHub CLI, please run: gh auth login\n");
    assert.equal(error.code, "GH_AUTH");
    assert.match(error.detail, /gh auth login/);
    assert.doesNotMatch(error.message, /To get started/);
    assert.ok(error instanceof GhError && error instanceof Error);
  });

  test("sortie trop volumineuse -> GH_PARSE (même si le processus a été tué)", () => {
    const error = Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
    assert.equal(classifyExecError(error).code, "GH_PARSE");
  });

  test("autre erreur de lancement -> GH_MISSING", () => {
    assert.equal(classifyExecError(Object.assign(new Error("x"), { code: "EACCES" })).code, "GH_MISSING");
    assert.equal(classifyExecError(undefined).code, "GH_MISSING");
  });

  test("le détail est borné", () => {
    const error = classifyExecError(Object.assign(new Error("x"), { code: 1 }), "x".repeat(5000));
    assert.ok(error.detail.length <= 500);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// fetchSnapshot avec un execFile simulé (options transmises à execFile, jamais de crash)
// ---------------------------------------------------------------------------------------------------------------

describe("fetchSnapshot avec execFile simulé (unitaire)", () => {
  // execFile simulé : renvoie le JSON de la fixture adaptée à la commande.
  function stubExecFile(log) {
    return (file, args, options, callback) => {
      log.push({ file, args, options });
      const joined = args.join(" ");
      let body = [];
      if (args[0] === "api") body = fixture("milestones.json");
      else if (args[0] === "issue") body = fixture("issues.json");
      else if (joined.includes("--state open")) body = fixture("pulls-open.json");
      else if (joined.includes("--base develop")) body = fixture("pulls-merged-develop.json");
      else body = fixture("pulls-merged-main.json");
      setImmediate(() => callback(null, JSON.stringify(body), ""));
    };
  }

  test("lance gh sans shell, avec un délai de 15 s, des arguments en tableau et le dossier demandé", async () => {
    const log = [];
    const cwd = os.tmpdir();
    const snapshot = await fetchSnapshot({ repo: "o/r", cwd, execFile: stubExecFile(log), now: FIXED_NOW });
    assert.equal(log.length, 5);
    for (const { file, args, options } of log) {
      assert.equal(file, "gh");
      assert.ok(Array.isArray(args) && args.every((a) => typeof a === "string"));
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 15000);
      assert.equal(GH_TIMEOUT_MS, 15000);
      assert.equal(options.cwd, cwd);
      assert.ok(options.maxBuffer >= 1024 * 1024);
      assert.equal(options.env.GH_PROMPT_DISABLED, "1");
    }
    assert.deepEqual(snapshot, fixture("expected-snapshot.json"));
  });

  test("timeoutMs et ghBin sont pris en compte", async () => {
    const log = [];
    await fetchSnapshot({ repo: "o/r", cwd: os.tmpdir(), timeoutMs: 1234, ghBin: "mon-gh", execFile: stubExecFile(log) });
    assert.ok(log.every((c) => c.file === "mon-gh" && c.options.timeout === 1234));
  });

  test("un repo invalide est refusé avant tout appel à gh", async () => {
    const log = [];
    for (const repo of ["o/r;x", "o", "../..", 12]) {
      await assert.rejects(fetchSnapshot({ repo, cwd: os.tmpdir(), execFile: stubExecFile(log) }), { code: "GH_REPO" });
    }
    assert.equal(log.length, 0);
  });

  test("un execFile qui lève de façon synchrone donne une erreur typée, sans plantage", async () => {
    const execFileQuiLeve = () => {
      throw Object.assign(new TypeError("argument invalide"), { code: "ERR_INVALID_ARG_VALUE" });
    };
    await assert.rejects(fetchSnapshot({ repo: "o/r", cwd: os.tmpdir(), execFile: execFileQuiLeve }), (error) => {
      assert.ok(error instanceof GhError);
      assert.equal(error.code, "GH_MISSING");
      return true;
    });
  });

  test("une erreur inattendue pendant la normalisation reste une GhError", async () => {
    const execFileTordu = (file, args, options, callback) => setImmediate(() => callback(null, "[null]", ""));
    await assert.rejects(fetchSnapshot({ repo: "o/r", cwd: os.tmpdir(), execFile: execFileTordu }), { code: "GH_PARSE" });
  });

  test("si plusieurs appels échouent, l'erreur renvoyée est celle du premier appel (milestones)", async () => {
    const execFileEnEchec = (file, args, options, callback) => {
      const error = args[0] === "api" ? Object.assign(new Error("x"), { code: "ENOENT" }) : Object.assign(new Error("x"), { code: 1 });
      setImmediate(() => callback(error, "", "stderr"));
    };
    await assert.rejects(fetchSnapshot({ repo: "o/r", cwd: os.tmpdir(), execFile: execFileEnEchec }), { code: "GH_MISSING" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Intégration : faux gh de tests/helpers
// ---------------------------------------------------------------------------------------------------------------

// Routes du faux gh pour la fixture (repo o/r). Le faux gh compare le début des arguments.
function fixtureRoutes() {
  return [
    { match: ["api", "-X", "GET", "repos/o/r/milestones"], json: fixture("milestones.json") },
    { match: ["issue", "list", "--repo", "o/r"], json: fixture("issues.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "open"], json: fixture("pulls-open.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "develop"], json: fixture("pulls-merged-develop.json") },
    { match: ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "main"], json: fixture("pulls-merged-main.json") },
  ];
}

/**
 * Installe le faux gh et un dossier de projet temporaire (avec `.gepet-squad.json` si `config` est fourni).
 * Retourne les options à passer à fetchSnapshot.
 *  - Linux / macOS : le faux gh est trouvé dans le PATH, `gh` est lancé tel quel (chemin de production).
 *  - Windows : le faux gh est un `.cmd`, qu'un execFile sans shell ne trouve pas. On injecte donc un execFile qui
 *    relance le script du faux gh avec Node, toujours sans shell.
 */
function setup(t, routes, config) {
  const fake = installFakeGh({ routes });
  const projectDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gepet-github-")));
  if (config) fs.writeFileSync(path.join(projectDir, ".gepet-squad.json"), JSON.stringify(config));
  t.after(() => {
    fake.cleanup();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const options = { cwd: projectDir, env: fake.env(), now: FIXED_NOW };
  if (process.platform === "win32") {
    const script = path.join(fake.dir, "fake-gh.cjs");
    options.execFile = (file, args, execOptions, callback) => {
      assert.equal(file, "gh", "fetchSnapshot doit lancer `gh` par défaut");
      return execFile(process.execPath, [script, ...args], execOptions, callback);
    };
  }
  return { fake, projectDir, options };
}

const sorted = (calls) => calls.map((c) => c.args).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe("fetchSnapshot avec le faux gh (intégration)", () => {
  test("renvoie l'instantané attendu et lance gh avec les bons arguments", async (t) => {
    const { fake, projectDir, options } = setup(t, fixtureRoutes());

    const snapshot = await fetchSnapshot({ repo: "o/r", ...options });

    assert.deepEqual(snapshot, fixture("expected-snapshot.json"));
    const expectedArgs = [
      ["api", "-X", "GET", "repos/o/r/milestones", "-f", "state=all", "-f", "per_page=100"],
      ["issue", "list", "--repo", "o/r", "--state", "all", "--limit", "500", "--json", "number,title,state,labels,milestone"],
      ["pr", "list", "--repo", "o/r", "--state", "open", "--limit", "200", "--json", "number,title,state,headRefName,baseRefName,url,isDraft,mergedAt"],
      ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "develop", "--limit", "200", "--json", "number,title,state,headRefName,baseRefName,url,isDraft,mergedAt"],
      ["pr", "list", "--repo", "o/r", "--state", "merged", "--base", "main", "--limit", "200", "--json", "number,title,state,headRefName,baseRefName,url,isDraft,mergedAt"],
    ];
    const calls = fake.calls();
    assert.equal(calls.length, 5);
    assert.deepEqual(sorted(calls), sorted(expectedArgs.map((args) => ({ args }))));
    for (const call of calls) assert.equal(fs.realpathSync.native(call.cwd), projectDir);
  });

  test("lit le repo et les branches dans .gepet-squad.json quand `repo` n'est pas donné", async (t) => {
    const routes = fixtureRoutes().map((r) =>
      r.match.includes("develop") ? { ...r, match: r.match.map((x) => (x === "develop" ? "dev" : x)) } : r,
    );
    const { fake, options } = setup(t, routes, {
      version: 1,
      repo: "o/r",
      branches: { integration: "dev", production: "main" },
    });

    const snapshot = await fetchSnapshot(options);

    assert.equal(snapshot.repo, "o/r");
    assert.equal(snapshot.pulls.length, 4);
    const bases = fake
      .calls()
      .filter((call) => call.args.includes("--base"))
      .map((call) => call.args[call.args.indexOf("--base") + 1]);
    assert.deepEqual(bases.sort(), ["dev", "main"]);
  });

  test("un repo invalide dans .gepet-squad.json est refusé sans appeler gh", async (t) => {
    const { fake, options } = setup(t, fixtureRoutes(), { version: 1, repo: "o/r; calc" });
    await assert.rejects(fetchSnapshot(options), { code: "GH_REPO" });
    assert.equal(fake.calls().length, 0);
  });

  test("un repo invalide passé en paramètre est refusé sans appeler gh", async (t) => {
    const { fake, options } = setup(t, fixtureRoutes(), { version: 1, repo: "o/r" });
    await assert.rejects(fetchSnapshot({ repo: "o/r --help", ...options }), { code: "GH_REPO" });
    assert.equal(fake.calls().length, 0);
  });

  test("sans .gepet-squad.json ni repo : GH_CONFIG, sans appel à gh", async (t) => {
    const { fake, options } = setup(t, fixtureRoutes());
    // Le dossier temporaire du système ne doit contenir aucun .gepet-squad.json au-dessus de lui.
    await assert.rejects(fetchSnapshot(options), { code: "GH_CONFIG" });
    assert.equal(fake.calls().length, 0);
  });

  test("gh absent -> GH_MISSING", async (t) => {
    const { options } = setup(t, fixtureRoutes());
    await assert.rejects(
      fetchSnapshot({ repo: "o/r", ...options, execFile: undefined, ghBin: "gh-introuvable-gepet-squad" }),
      (error) => {
        assert.ok(error instanceof GhError);
        assert.equal(error.code, "GH_MISSING");
        return true;
      },
    );
  });

  test("code de sortie non nul -> GH_AUTH, sans fuite du stderr dans le message", async (t) => {
    const { fake, options } = setup(t, [
      { match: [], stderr: "gh: To get started with GitHub CLI, please run:  gh auth login\n", exitCode: 4 },
    ]);
    await assert.rejects(fetchSnapshot({ repo: "o/r", ...options }), (error) => {
      assert.ok(error instanceof GhError);
      assert.equal(error.code, "GH_AUTH");
      assert.match(error.detail, /gh auth login/);
      assert.doesNotMatch(error.message, /auth login/);
      return true;
    });
    assert.ok(fake.calls().length >= 1);
  });

  test("délai dépassé -> GH_TIMEOUT, et fetchSnapshot rend la main sans attendre la réponse du faux gh", async (t) => {
    const routes = fixtureRoutes();
    routes[1] = { ...routes[1], delayMs: 20000 };
    const { options } = setup(t, routes);
    const debut = Date.now();
    await assert.rejects(fetchSnapshot({ repo: "o/r", ...options, timeoutMs: 400 }), (error) => {
      assert.ok(error instanceof GhError);
      assert.equal(error.code, "GH_TIMEOUT");
      return true;
    });
    assert.ok(Date.now() - debut < 10000, "le délai de 400 ms doit s'appliquer");
  });

  test("JSON invalide -> GH_PARSE", async (t) => {
    const routes = fixtureRoutes();
    routes[2] = { ...routes[2], json: undefined, stdout: "ceci n'est pas du JSON {" };
    const { options } = setup(t, routes);
    await assert.rejects(fetchSnapshot({ repo: "o/r", ...options }), (error) => {
      assert.ok(error instanceof GhError);
      assert.equal(error.code, "GH_PARSE");
      return true;
    });
  });

  test("JSON valide mais de forme inattendue (objet au lieu d'un tableau) -> GH_PARSE", async (t) => {
    const routes = fixtureRoutes();
    routes[0] = { ...routes[0], json: { message: "Not Found", status: "404" } };
    const { options } = setup(t, routes);
    await assert.rejects(fetchSnapshot({ repo: "o/r", ...options }), { code: "GH_PARSE" });
  });

  test("sortie vide -> GH_PARSE", async (t) => {
    const routes = fixtureRoutes();
    routes[3] = { match: routes[3].match, stdout: "" };
    const { options } = setup(t, routes);
    await assert.rejects(fetchSnapshot({ repo: "o/r", ...options }), { code: "GH_PARSE" });
  });

  test("liste vide partout : instantané vide mais valide", async (t) => {
    const { options } = setup(t, fixtureRoutes().map((r) => ({ match: r.match, json: [] })));
    const snapshot = await fetchSnapshot({ repo: "o/r", ...options });
    assert.deepEqual(snapshot, {
      repo: "o/r",
      fetchedAt: "2026-10-30T12:00:00.000Z",
      issues: [],
      milestones: [],
      pulls: [],
    });
  });
});

describe("readConfig (intégration)", () => {
  test("remonte les dossiers parents jusqu'à .gepet-squad.json", (t) => {
    const { projectDir } = setup(t, [], { version: 1, repo: "o/r" });
    const sub = path.join(projectDir, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(readConfig(sub).repo, "o/r");
  });

  test("JSON invalide, tableau ou fichier absent -> GH_CONFIG", (t) => {
    const { projectDir } = setup(t, []);
    assert.throws(() => readConfig(projectDir), { code: "GH_CONFIG" });
    fs.writeFileSync(path.join(projectDir, ".gepet-squad.json"), "{ pas du json");
    assert.throws(() => readConfig(projectDir), { code: "GH_CONFIG" });
    fs.writeFileSync(path.join(projectDir, ".gepet-squad.json"), "[1]");
    assert.throws(() => readConfig(projectDir), { code: "GH_CONFIG" });
  });
});
