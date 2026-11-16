// Section « Consommation » de /gepet-squad-status : le skill doit appeler la CLI avec ses arguments, sans la rendre bloquante.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SKILL = fs.readFileSync(path.join(ROOT, "skills", "gepet-squad-status", "SKILL.md"), "utf8");
const CLI = fs.readFileSync(path.join(ROOT, "conso", "cli.cjs"), "utf8");

describe("skill gepet-squad-status : consommation", () => {
  test("appelle la CLI conso avec --project et un --milestone par milestone", () => {
    assert.ok(SKILL.includes('node "${CLAUDE_PLUGIN_ROOT}/conso/cli.cjs" --project "<cwd>"'));
    assert.ok(SKILL.includes('--milestone "<titre>=<ids>"'));
    for (const option of ["project", "milestone"]) assert.match(CLI, new RegExp(`\\b${option}: \\{ type: "string"`));
  });

  test("source des ids : gh --state all en normal, colonne Milestone de etat.md en économe local", () => {
    assert.match(SKILL, /gh issue list --state all/);
    assert.match(SKILL, /F-xx/);
    assert.match(SKILL, /colonne `Milestone`/);
  });

  test("CLI vide ou warnings : une ligne, sans faire échouer le statut", () => {
    assert.match(SKILL, /warnings/);
    assert.match(SKILL, /sans faire échouer le statut/);
  });
});
