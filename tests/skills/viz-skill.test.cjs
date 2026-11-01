// Commande /gepet-squad-viz : le skill est du Markdown, mais son contrat avec la CLI de viz/server.cjs est vérifiable.
// Ces tests échouent si le frontmatter casse, si le skill se met à gérer des pid ou des signaux lui-même, ou si une
// sous-commande disparaît de la CLI qu'il appelle.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SKILL_FILE = path.join(ROOT, "skills", "gepet-squad-viz", "SKILL.md");
const SKILL = fs.readFileSync(SKILL_FILE, "utf8");
const SERVER = fs.readFileSync(path.join(ROOT, "viz", "server.cjs"), "utf8");

/** Frontmatter en paires `clé: valeur` (suffisant pour les clés à une ligne de ce skill). */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, "le skill doit commencer par un frontmatter YAML");
  return Object.fromEntries(
    match[1].split(/\r?\n/).map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
}

describe("skill gepet-squad-viz", () => {
  test("frontmatter : nom, description, argument et invocation manuelle seulement", () => {
    const meta = frontmatter(SKILL);
    assert.equal(meta.name, "gepet-squad-viz");
    assert.ok(meta.description.length > 20);
    assert.equal(meta["argument-hint"], '"[stop]"');
    assert.equal(meta["disable-model-invocation"], "true");
  });

  test("le dossier porte le nom de la commande", () => {
    assert.equal(path.basename(path.dirname(SKILL_FILE)), frontmatter(SKILL).name);
  });

  test("appelle les formes de la CLI, avec le chemin du plugin et le projet courant", () => {
    const cli = 'node "${CLAUDE_PLUGIN_ROOT}/viz/server.cjs"';
    assert.ok(SKILL.includes(`${cli} status --project "<cwd>"\n`), "status --project");
    assert.ok(SKILL.includes(`${cli} --project "<cwd>"\n`), "démarrage --project");
    assert.ok(SKILL.includes(`${cli} status --project "<cwd>" --wait 20`), "status --wait 20");
    assert.ok(SKILL.includes(`${cli} stop --project "<cwd>"`), "stop --project");
    assert.match(SKILL, /run_in_background: true/);
  });

  test("ne contient aucune logique de pid ni de signal", () => {
    const body = SKILL.replace(/^---[\s\S]*?---/, "");
    assert.doesNotMatch(body, /\b(pid|kill|taskkill|SIGTERM|SIGKILL|process\.kill)\b/i);
    assert.doesNotMatch(body, /viz\.lock/);
  });

  test("les sous-commandes et options appelées existent dans la CLI", () => {
    for (const token of ["status --project <dir> [--wait <s>]", "stop --project <dir>"]) {
      assert.ok(SERVER.includes(token), `la CLI doit documenter « ${token} »`);
    }
    const max = /MAX_WAIT_SECONDS = (\d+)/.exec(SERVER);
    assert.ok(max, "MAX_WAIT_SECONDS introuvable");
    assert.ok(Number(max[1]) >= 20, "--wait 20 doit être accepté");
  });

  test("le repli texte annoncé existe côté client", () => {
    const fallback = fs.readFileSync(path.join(ROOT, "viz", "public", "js", "fallback.js"), "utf8");
    assert.ok(SKILL.includes("?mode=texte"));
    assert.ok(fallback.includes("?mode=texte"));
  });
});
