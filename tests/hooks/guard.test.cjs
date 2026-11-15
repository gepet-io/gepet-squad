// Tests d'intégration de hooks/guard.cjs : le garde-fou est exécuté en sous-processus, comme le fait Claude Code,
// dans un repo git temporaire contenant .gepet-squad.json (mode normal, puis mode économe).
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createTempRepo, gitEnv } = require("../helpers/index.cjs");

const GUARD_CJS = path.join(__dirname, "..", "..", "hooks", "guard.cjs");

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

function squadRepo(config) {
  const repo = createTempRepo();
  cleanups.push(repo.cleanup);
  fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), JSON.stringify(config));
  return repo;
}

// Renvoie la raison du refus, ou null si la commande passe.
function guard(cwd, command) {
  const res = spawnSync(process.execPath, [GUARD_CJS], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
    encoding: "utf8",
    env: gitEnv(),
  });
  assert.equal(res.status, 0, res.stderr);
  if (!res.stdout.trim()) return null;
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe("garde-fou : mode normal", () => {
  test("bloque le push sur main, laisse passer le push d'une branche de feature", () => {
    const { dir } = squadRepo({ version: 1, mode: "normal" });
    assert.match(guard(dir, "git push origin main"), /main/);
    assert.equal(guard(dir, "git push -u origin feature/3-login"), null);
  });

  test("bloque `git merge` quand la branche courante est main", () => {
    const { dir } = squadRepo({ version: 1 });
    assert.match(guard(dir, "git merge --no-ff release/m1-socle"), /Merge sur main/);
    assert.equal(guard(dir, "git merge --abort"), null);
  });

  test("bloque `git merge` après un `git switch main` dans la même ligne, pas après un switch sur develop", () => {
    const { dir, git } = squadRepo({ version: 1 });
    git(dir, ["switch", "-c", "develop"]);
    assert.equal(guard(dir, "git merge --squash feature/F-01-init"), null);
    assert.match(guard(dir, "git switch main && git merge release/m1-socle"), /Merge sur main/);
    assert.equal(guard(dir, "git switch main && git switch develop && git merge feature/x"), null);
  });

  test("laisse passer les commandes gh en mode normal", () => {
    const { dir } = squadRepo({ version: 1, mode: "normal" });
    assert.equal(guard(dir, 'gh issue create --repo o/r --title "x" --body-file f'), null);
  });

  test("ne fait rien hors d'un projet squad", () => {
    const repo = createTempRepo();
    cleanups.push(repo.cleanup);
    assert.equal(guard(repo.dir, "git push origin main"), null);
  });
});

describe("garde-fou : mode économe", () => {
  test("bloque tout push", () => {
    const { dir } = squadRepo({ version: 1, mode: "econome" });
    assert.match(guard(dir, "git push -u origin feature/F-01-init"), /Mode économe/);
    assert.match(guard(dir, "git add . && git commit -m x && git push"), /Mode économe/);
  });

  test("bloque les écritures gh, laisse passer les lectures", () => {
    const { dir } = squadRepo({ version: 1, mode: "econome" });
    for (const cmd of [
      'gh issue create --title "x" --body-file f',
      "gh issue edit 3 --add-label status:ready",
      "gh pr create --base develop",
      "gh pr comment 4 --body-file -",
      "gh label create status:ready --force",
      "gh repo create demo --private",
      "gh api repos/o/r/milestones -f title=M1",
      "gh api -X PATCH repos/o/r/milestones/1 -f state=closed",
      "cat body.md | gh pr comment 4 --body-file -",
    ]) {
      assert.match(guard(dir, cmd) || "", /Mode économe/, cmd);
    }
    for (const cmd of ["gh auth status", "gh api repos/o/r/releases", "gh api -X GET repos/o/r -f per_page=1", "gh pr view 3"]) {
      assert.equal(guard(dir, cmd), null, cmd);
    }
  });

  test("laisse passer le travail Git local", () => {
    const { dir } = squadRepo({ version: 1, mode: "econome" });
    assert.equal(guard(dir, "git switch -c feature/F-01-init develop"), null);
    assert.equal(guard(dir, "git commit -m 'feat(api): init (F-01)'"), null);
  });
});

describe("garde-fou : mode économe hybride", () => {
  test("laisse passer push, issues et PR, bloque les commentaires de rapport", () => {
    const { dir } = squadRepo({ version: 1, mode: "econome", suivi: "hybride" });
    assert.equal(guard(dir, "git push -u origin feature/3-login"), null);
    assert.equal(guard(dir, "gh pr create --base develop --head feature/3-login"), null);
    assert.equal(guard(dir, "gh issue edit 3 --remove-label status:ready --add-label status:in-progress"), null);
    assert.match(guard(dir, "gh pr comment 4 --body-file -") || "", /hybride/);
    assert.match(guard(dir, "gh issue comment 3 --body x") || "", /hybride/);
    assert.match(guard(dir, "git push origin main") || "", /main/);
  });
});
