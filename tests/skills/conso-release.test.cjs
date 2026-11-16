// La section « Consommation » de la release vit dans des prompts Markdown : ces tests échouent si elle disparaît.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const REFS = ["skills", "gepet-squad", "references"];

describe("bilan de consommation à la release", () => {
  test("la phase 5 du SKILL appelle la CLI avec --milestone et --focus", () => {
    const skill = read("skills", "gepet-squad", "SKILL.md");
    const phase5 = skill.slice(skill.indexOf("## Phase 5"), skill.indexOf("## Phase 6"));
    assert.match(phase5, /conso\/cli\.cjs/);
    assert.match(phase5, /--milestone/);
    assert.match(phase5, /--focus/);
    assert.match(phase5, /Consommation/);
  });

  test("la phase 6 du SKILL appelle la CLI sans --focus", () => {
    const skill = read("skills", "gepet-squad", "SKILL.md");
    const phase6 = skill.slice(skill.indexOf("## Phase 6"));
    assert.match(phase6, /conso\/cli\.cjs/);
    assert.match(phase6, /sans `--focus`/);
  });

  for (const file of ["github-conventions.md", "mode-econome.md"]) {
    test(`${file} décrit la section « Consommation » et la CLI`, () => {
      const doc = read(...REFS, file);
      assert.match(doc, /conso\/cli\.cjs/);
      assert.match(doc, /« Consommation »|## Consommation/);
      assert.match(doc, /warnings/);
    });
  }
});
