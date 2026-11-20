// scripts/squad.cjs : transitions du Chef de projet en une commande. Fonctions pures, puis intégration en
// économe local (vrai repo git temporaire) et en mode normal (faux gh, aucun appel réseau).
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createTempRepo, gitEnv, installFakeGh } = require("../helpers/index.cjs");
const squad = require("../../scripts/squad.cjs");

const SQUAD_CJS = path.join(__dirname, "..", "..", "scripts", "squad.cjs");

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

const ETAT = `# État du projet — demo

## Milestones
| Milestone | Statut | Release |
|---|---|---|
| M1 — Socle | en cours | — |

## Features
| Feature | Titre | Milestone | Scope | Statut | Retry | Dépendances | Branche |
|---|---|---|---|---|---|---|---|
| F-01 | Initialiser l'API | M1 — Socle | api | in-test | 1 | aucune | feature/F-01-init |
| F-02 | Exposer la réservation | M1 — Socle | api | backlog | 0 | F-01 | — |
| F-03 | Page d'accueil | M1 — Socle | web | backlog | 0 | F-01, F-02 | — |
`;

function run(cwd, args, env = {}) {
  const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const res = spawnSync(process.execPath, [SQUAD_CJS, ...args], { cwd, encoding: "utf8", env: { ...gitEnv(), ...identity, ...env } });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

describe("squad.cjs : fonctions pures", () => {
  test("labelEditArgs retire tous les autres statuts, et les retries seulement si le compteur change", () => {
    const args = squad.labelEditArgs(7, "o/r", "changes-requested", 2);
    const remove = args[args.indexOf("--remove-label") + 1].split(",");
    const add = args[args.indexOf("--add-label") + 1].split(",");
    assert.deepEqual(add, ["status:changes-requested", "retry:2"]);
    assert.ok(remove.includes("status:in-test") && remove.includes("retry:1") && remove.includes("retry:3"));
    assert.ok(!remove.includes("status:changes-requested") && !remove.includes("retry:2"));
    const plain = squad.labelEditArgs(7, "o/r", "in-review");
    assert.ok(!plain[plain.indexOf("--remove-label") + 1].includes("retry:"));
    const done = squad.labelEditArgs(7, "o/r", "done", 2);
    assert.equal(done[done.indexOf("--add-label") + 1], "status:done");
    assert.match(done[done.indexOf("--remove-label") + 1], /retry:1,retry:2,retry:3/);
  });

  test("statut inconnu : erreur d'usage", () => {
    assert.throws(() => squad.labelEditArgs(1, "o/r", "en-cours"), (e) => e.code === 2);
  });

  test("depsFromBody ne lit que la section Dépendances", () => {
    const body = "## Contexte\nVoir #99\n\n## Dépendances\n- #3\n- owner/hub#4, #3\n\n## Taille\nS\n";
    assert.deepEqual(squad.depsFromBody(body), [3, 4]);
    assert.deepEqual(squad.depsFromBody("## Dépendances\naucune"), []);
    assert.deepEqual(squad.depsFromBody(undefined), []);
  });

  test("parseEtat et setRowStatus ne touchent que la ligne visée", () => {
    const etat = squad.parseEtat(ETAT);
    assert.deepEqual(etat.rows.map((r) => r.id), ["F-01", "F-02", "F-03"]);
    const text = squad.setRowStatus(etat, "F-02", "ready");
    assert.match(text, /\| F-02 \| Exposer la réservation \| M1 — Socle \| api \| ready \| 0 \| F-01 \| — \|/);
    assert.equal(text.split("\n").filter((l, i) => l !== ETAT.split("\n")[i]).length, 1);
  });

  test("unblockable et readyList suivent les dépendances", () => {
    const items = [
      { id: "F-02", status: "backlog", deps: ["F-01"] },
      { id: "F-03", status: "backlog", deps: ["F-01", "F-02"] },
      { id: "F-04", status: "ready", deps: [] },
    ];
    assert.deepEqual(squad.unblockable(items, ["F-01"]), ["F-02"]);
    assert.deepEqual(squad.readyList(items, []), ["F-04"]);
  });

  test("commandLine produit une ligne que le collecteur sait relire", () => {
    const { ghCommandToEvents } = require("../../hooks/lib/gh-command.cjs");
    const line = squad.commandLine("gh", ["issue", "close", "7", "--repo", "o/r", "--comment", "Mergée sur develop via #12"]);
    const events = ghCommandToEvents(line, { now: "2026-11-20T00:00:00.000Z" });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "issue.closed");
  });
});

describe("squad.cjs : économe local", () => {
  function localRepo() {
    const repo = createTempRepo();
    cleanups.push(repo.cleanup);
    const { dir, git } = repo;
    fs.writeFileSync(path.join(dir, ".gepet-squad.json"), JSON.stringify({ repo: "local", mode: "econome", ci: { mode: "local", commands: [] } }));
    fs.mkdirSync(path.join(dir, "docs", "squad"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "squad", "etat.md"), ETAT);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "docs: suivi"]);
    git(dir, ["switch", "-c", "develop"]);
    git(dir, ["switch", "-c", "feature/F-01-init"]);
    fs.writeFileSync(path.join(dir, "api.txt"), "api\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "feat(api): init"]);
    git(dir, ["switch", "develop"]);
    return repo;
  }

  test("etat liste le milestone courant et les features prêtes, sans gh", () => {
    const { dir } = localRepo();
    const res = run(dir, ["etat"], { GEPET_GH_SCRIPT: "/inexistant.cjs" });
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /^Milestone : M1 — Socle/);
    assert.match(res.out, /F-01 in-test r1 deps:aucune/);
    assert.match(res.out, /Prêtes : aucune/);
  });

  test("statut modifie la ligne et le retry", () => {
    const { dir } = localRepo();
    const res = run(dir, ["statut", "F-01", "changes-requested", "--retry", "2"]);
    assert.equal(res.code, 0, res.err);
    assert.equal(res.out, "F-01 : in-test → changes-requested (retry 2)");
    assert.match(fs.readFileSync(path.join(dir, "docs", "squad", "etat.md"), "utf8"), /\| F-01 \|.*\| changes-requested \| 2 \|/);
  });

  test("merge : squash sur develop, done, déblocage, suivi commité, branche supprimée", () => {
    const { dir, git } = localRepo();
    const res = run(dir, ["merge", "F-01"]);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /F-01 mergée sur develop/);
    assert.match(res.out, /Débloquées \(backlog → ready\) : F-02$/m);
    const etat = fs.readFileSync(path.join(dir, "docs", "squad", "etat.md"), "utf8");
    assert.match(etat, /\| F-01 \|.*\| done \| 0 \|/);
    assert.match(etat, /\| F-02 \|.*\| ready \| 0 \|/);
    assert.match(etat, /\| F-03 \|.*\| backlog \| 0 \|/);
    assert.equal(git(dir, ["log", "-2", "--format=%s"]), "docs(squad): F-01 mergée\nfeat(api): Initialiser l'API (F-01)");
    assert.equal(git(dir, ["branch", "--list", "feature/*"]), "");
    assert.equal(git(dir, ["status", "--porcelain"]), "");
  });

  test("merge refusé hors de develop", () => {
    const { dir, git } = localRepo();
    git(dir, ["switch", "main"]);
    const res = run(dir, ["merge", "F-01"]);
    assert.equal(res.code, 3);
    assert.match(res.err, /jamais de merge sur main/);
  });

  test("identifiant de mauvaise forme : erreur d'usage", () => {
    const { dir } = localRepo();
    assert.equal(run(dir, ["statut", "12", "ready"]).code, 2);
  });
});

describe("squad.cjs : mode normal (faux gh)", () => {
  function normalRepo(routes) {
    const repo = createTempRepo();
    cleanups.push(repo.cleanup);
    fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), JSON.stringify({ repo: "o/r", mode: "normal" }));
    const gh = installFakeGh({ routes });
    cleanups.push(gh.cleanup);
    return { ...repo, gh, env: { GEPET_GH_SCRIPT: path.join(gh.dir, "fake-gh.cjs") } };
  }

  const ISSUES = [
    { number: 7, title: "Init", state: "OPEN", labels: [{ name: "status:in-test" }], milestone: { title: "M1", number: 1 }, body: "## Dépendances\naucune\n" },
    { number: 8, title: "Suite", state: "OPEN", labels: [{ name: "status:backlog" }], milestone: { title: "M1", number: 1 }, body: "## Dépendances\n- #7\n" },
  ];

  test("statut : une seule commande gh issue edit", () => {
    const { dir, gh, env } = normalRepo([{ match: ["issue", "edit"], stdout: "" }]);
    const res = run(dir, ["statut", "7", "in-review"], env);
    assert.equal(res.code, 0, res.err);
    const calls = gh.calls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 5), ["issue", "edit", "7", "--repo", "o/r"]);
  });

  test("merge : vérifie la tête, merge, ferme, débloque", () => {
    const { dir, gh, env } = normalRepo([
      { match: ["pr", "view"], json: { headRefOid: "abc1234def", baseRefName: "develop", state: "OPEN" } },
      { match: ["pr", "merge"], stdout: "" },
      { match: ["issue", "edit"], stdout: "" },
      { match: ["issue", "close"], stdout: "" },
      { match: ["issue", "list"], json: ISSUES },
    ]);
    const res = run(dir, ["merge", "7", "--pr", "12", "--sha", "abc1234"], env);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /Débloquées \(backlog → ready\) : #8/);
    const seq = gh.calls().map((c) => c.args.slice(0, 3).join(" "));
    assert.deepEqual(seq, ["pr view 12", "pr merge 12", "issue edit 7", "issue close 7", "issue list --repo", "issue edit 8"]);
  });

  test("merge refusé si la PR a reçu des commits après la vérification", () => {
    const { dir, gh, env } = normalRepo([{ match: ["pr", "view"], json: { headRefOid: "fff0000", baseRefName: "develop", state: "OPEN" } }]);
    const res = run(dir, ["merge", "7", "--pr", "12", "--sha", "abc1234"], env);
    assert.equal(res.code, 3);
    assert.match(res.err, /nouveaux commits/);
    assert.equal(gh.calls().length, 1);
  });

  test("merge refusé vers main", () => {
    const { dir, env } = normalRepo([{ match: ["pr", "view"], json: { headRefOid: "a", baseRefName: "main", state: "OPEN" } }]);
    const res = run(dir, ["merge", "7", "--pr", "12"], env);
    assert.equal(res.code, 3);
    assert.match(res.err, /seul un merge vers develop/);
  });
});
