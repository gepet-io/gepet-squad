// La documentation de la consommation vit dans le README : ce test échoue si ses éléments clés disparaissent.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const section = readme.slice(readme.indexOf("## Consommation"), readme.indexOf("## Commandes"));

describe("README, section Consommation", () => {
  for (const needle of ["node conso/cli.cjs", "cleanupPeriodDays", "ccusage"]) {
    test(`mentionne ${needle}`, () => {
      assert.ok(section.includes(needle), `${needle} absent de la section « Consommation »`);
    });
  }
});
