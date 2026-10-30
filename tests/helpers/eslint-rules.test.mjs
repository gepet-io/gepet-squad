// Vérifie la configuration ESLint du repo avec l'API ESLint (règles par zone du repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const eslint = new ESLint({ cwd: racine });

async function regles(code, filePath) {
  const [resultat] = await eslint.lintText(code, { filePath });
  return resultat.messages.map((m) => m.ruleId);
}

test("innerHTML est une erreur dans viz/public/js", async () => {
  const [resultat] = await eslint.lintText("el.innerHTML = x", { filePath: "viz/public/js/x.js" });
  const erreur = resultat.messages.find((m) => m.ruleId === "no-restricted-properties");
  assert.ok(erreur, "no-restricted-properties doit signaler innerHTML");
  assert.equal(erreur.severity, 2);
  assert.match(erreur.message, /innerHTML/);
});

test("outerHTML est une erreur dans viz/public/js", async () => {
  assert.ok((await regles("const s = el.outerHTML;", "viz/public/js/x.js")).includes("no-restricted-properties"));
});

test("textContent reste autorisé dans viz/public/js", async () => {
  assert.deepEqual(await regles("export function f(el, x) { el.textContent = x; }", "viz/public/js/x.js"), []);
});

test("la règle ne s'applique pas hors de viz/public/js", async () => {
  assert.equal((await regles("el.innerHTML = x", "hooks/x.cjs")).includes("no-restricted-properties"), false);
  assert.equal((await regles("el.innerHTML = x", "tests/x.test.mjs")).includes("no-restricted-properties"), false);
});

test("globals navigateur dans viz/public/js, Node ailleurs", async () => {
  assert.deepEqual(await regles("export const t = document.title;", "viz/public/js/x.js"), []);
  assert.ok((await regles("module.exports = document.title;", "hooks/x.cjs")).includes("no-undef"));
  assert.deepEqual(await regles("module.exports = process.platform;", "hooks/x.cjs"), []);
  assert.deepEqual(await regles("export const p = process.platform;", "tests/x.test.mjs"), []);
});

test("viz/public/vendor et node_modules sont ignorés", async () => {
  assert.equal(await eslint.isPathIgnored(path.join(racine, "viz/public/vendor/three/three.module.js")), true);
  assert.equal(await eslint.isPathIgnored(path.join(racine, "node_modules/eslint/index.js")), true);
  assert.equal(await eslint.isPathIgnored(path.join(racine, "viz/public/js/main.js")), false);
});
