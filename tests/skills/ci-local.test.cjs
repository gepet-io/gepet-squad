// Mode « CI locale » : le contrat vit dans des prompts Markdown. Ces tests échouent si la clé `ci` disparaît de la
// documentation, si un agent ou le skill cesse de la gérer, ou si la config de ce repo devient invalide.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("mode CI locale", () => {
  test("github-conventions.md documente ci.mode, ci.commands et la ligne de PR de release", () => {
    const doc = read("skills", "gepet-squad", "references", "github-conventions.md");
    assert.match(doc, /"ci": \{ "mode": "github" \| "local", "commands"/);
    assert.match(doc, /`commands`/);
    assert.match(doc, /CI locale sur develop : <N>\/<N> commandes OK/);
  });

  for (const [name, file] of [
    ["testeur", ["agents", "testeur.md"]],
    ["developpeur", ["agents", "developpeur.md"]],
    ["SKILL gepet-squad", ["skills", "gepet-squad", "SKILL.md"]],
  ]) {
    test(`${name} conditionne le mode local à ci.mode et ci.commands`, () => {
      const text = read(...file);
      assert.match(text, /`ci\.mode` (=|vaut) `local`/);
      assert.match(text, /`ci\.commands`/);
    });
  }

  test("testeur : section CI locale avec lignes OK / ÉCHEC", () => {
    const text = read("agents", "testeur.md");
    assert.match(text, /### CI locale/);
    assert.match(text, /→ OK/);
    assert.match(text, /→ ÉCHEC/);
  });

  test("resume signale le mode local", () => {
    assert.match(read("skills", "gepet-squad-resume", "SKILL.md"), /`ci\.mode` = `local`/);
  });

  test(".gepet-squad.json de ce repo : ci.commands est un tableau non vide de chaînes", () => {
    const cfg = JSON.parse(read(".gepet-squad.json"));
    assert.equal(cfg.ci.mode, "local");
    assert.ok(Array.isArray(cfg.ci.commands) && cfg.ci.commands.length > 0);
    for (const c of cfg.ci.commands) assert.ok(typeof c === "string" && c.trim() !== "");
  });
});
