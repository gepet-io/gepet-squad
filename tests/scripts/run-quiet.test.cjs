// scripts/run-quiet.sh : la sortie reste courte, le log complet va dans un fichier, le code de sortie est conservé.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "run-quiet.sh");
const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-quiet-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, cwd) {
  const logs = tempDir();
  const res = spawnSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, GEPET_LOG_DIR: logs } });
  return { code: res.status, out: res.stdout, logs };
}

describe("run-quiet.sh", () => {
  test("succès : verdict OK et fin du log seulement", () => {
    const res = run(["for i in $(seq 1 200); do echo ligne $i; done"], tempDir());
    assert.equal(res.code, 0);
    assert.match(res.out, /→ OK/);
    assert.ok(res.out.split("\n").length <= 6, res.out);
    const [log] = fs.readdirSync(res.logs);
    assert.equal(fs.readFileSync(path.join(res.logs, log), "utf8").split("\n").filter(Boolean).length, 200);
  });

  test("échec : code conservé, lignes d'erreur extraites, sortie bornée", () => {
    const res = run(["for i in $(seq 1 500); do echo ok $i; done; echo 'FAIL: test_panier'; exit 4"], tempDir());
    assert.equal(res.code, 4);
    assert.match(res.out, /→ ÉCHEC \(code 4/);
    assert.match(res.out, /FAIL: test_panier/);
    assert.ok(res.out.split("\n").length < 30, res.out);
  });

  test("--ci : une ligne par commande de ci.commands et un total", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, ".gepet-squad.json"), JSON.stringify({ ci: { commands: ["echo un", "exit 1", "echo trois"] } }));
    const res = run(["--ci"], dir);
    assert.equal(res.code, 1);
    assert.match(res.out, /^echo un → OK/m);
    assert.match(res.out, /^exit 1 → ÉCHEC/m);
    assert.match(res.out, /CI locale : 2\/3 commandes OK/);
  });

  test("sans argument : usage", () => {
    assert.equal(run([], tempDir()).code, 2);
  });
});
