// Mode économe et tests sobres : le contrat vit dans des prompts Markdown. Ces tests échouent si une pièce
// (question de démarrage, champ SUIVI, références, CI minimale, bootstrap local) disparaît.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const REFS = ["skills", "gepet-squad", "references"];

describe("mode économe", () => {
  test("le Chef de projet demande le mode avant tout démarrage, économe recommandé par défaut", () => {
    const skill = read("skills", "gepet-squad", "SKILL.md");
    assert.match(skill, /Avant tout démarrage/);
    assert.match(skill, /Oui, mode économe \(Recommandé\)/);
    assert.match(skill, /bootstrap\.sh" --local/);
    assert.match(skill, /mode-econome\.md/);
    assert.match(skill, /tests-et-ci\.md/);
  });

  test("mode-econome.md décrit le suivi local et interdit GitHub", () => {
    const doc = read(...REFS, "mode-econome.md");
    for (const needle of ["docs/squad/etat.md", "features/F-01", "rapports/F-01", "releases/m1", "`SUIVI`", "aucun push", "git merge --squash"]) {
      assert.ok(doc.includes(needle), needle);
    }
  });

  for (const agent of ["developpeur", "verificateur", "testeur", "architecte"]) {
    test(`${agent} gère le mode économe (SUIVI, aucune commande gh)`, () => {
      const text = read("agents", `${agent}.md`);
      assert.match(text, /[Mm]ode économe/);
      assert.match(text, /SUIVI/);
    });
  }

  test("report-formats.md : champ SUIVI et Détail en chemin de fichier", () => {
    const doc = read(...REFS, "report-formats.md");
    assert.match(doc, /`SUIVI`/);
    assert.match(doc, /`PR: local`/);
  });

  test("bootstrap.sh accepte --local sans appel à gh", () => {
    const sh = read("scripts", "bootstrap.sh");
    const local = sh.slice(sh.indexOf('if [ "${1:-}" = "--local" ]'), sh.indexOf("exit 0"));
    assert.ok(local.length > 0);
    assert.doesNotMatch(local, /\bgh\s/);
    assert.doesNotMatch(local, /git push/);
    assert.match(local, /"mode": "econome"/);
  });

  test("resume et status lisent etat.md en mode économe", () => {
    assert.match(read("skills", "gepet-squad-resume", "SKILL.md"), /docs\/squad\/etat\.md/);
    assert.match(read("skills", "gepet-squad-status", "SKILL.md"), /docs\/squad\/etat\.md/);
  });
});

describe("tests sobres et CI minimale", () => {
  test("tests-et-ci.md : budget de 3 minutes, pas d'artefact, packages désactivés par défaut", () => {
    const doc = read(...REFS, "tests-et-ci.md");
    assert.match(doc, /3 min/);
    assert.match(doc, /upload-artifact/);
    assert.match(doc, /"packages": \{ "enabled": false \}/);
    assert.match(doc, /release: types: \[published\]/);
    assert.doesNotMatch(doc.slice(doc.indexOf("```yaml")), /^\s+- uses: actions\/upload-artifact/m);
  });

  test("le testeur ne lance la baseline qu'en cas d'échec du candidat", () => {
    assert.match(read("agents", "testeur.md"), /Baseline, seulement si le candidat a des échecs/);
  });

  test("le vérificateur valide les tests complexes", () => {
    const text = read("agents", "verificateur.md");
    assert.match(text, /\*\*Tests complexes\*\*/);
    assert.match(read(...REFS, "report-formats.md"), /Tests complexes: <passés>\/<lancés> \| aucun/);
  });
});

describe("économe hybride et CI à la release", () => {
  test("phase 0 : deux questions, mode puis suivi local ou hybride", () => {
    const skill = read("skills", "gepet-squad", "SKILL.md");
    assert.match(skill, /Local \(Recommandé\)/);
    assert.match(skill, /\*\*Hybride\*\*/);
    assert.match(skill, /--hybride/);
  });

  test("mode-econome.md décrit la variante hybride", () => {
    const doc = read(...REFS, "mode-econome.md");
    assert.match(doc, /## Deux variantes : local ou hybride/);
    assert.match(doc, /"suivi": "local" \| "hybride"/);
  });

  for (const agent of ["developpeur", "verificateur", "testeur"]) {
    test(`${agent} distingue économe local et hybride`, () => {
      const text = read("agents", `${agent}.md`);
      assert.match(text, /\*\*Mode économe local\*\*/);
      assert.match(text, /\*\*Mode économe hybride\*\*/);
    });
  }

  test("bootstrap : normal en ci.mode release, hybride en econome + ci local", () => {
    const sh = read("scripts", "bootstrap.sh");
    assert.match(sh, /"ci": \{ "mode": "release", "commands": \[\] \}/);
    assert.match(sh, /"suivi": "hybride"/);
  });

  test("tests-et-ci.md : CI GitHub seulement sur les PR vers main en ci.mode release", () => {
    const doc = read(...REFS, "tests-et-ci.md");
    assert.match(doc, /\| `release` \|/);
    assert.match(doc, /branches: \[main\]/);
  });

  test("labels groupés : une seule commande gh issue edit par transition", () => {
    assert.match(read(...REFS, "github-conventions.md"), /Une transition = \*\*une seule\*\* commande `gh issue edit`/);
    assert.match(read("skills", "gepet-squad", "SKILL.md"), /\*\*Labels groupés\.\*\*/);
  });
});

describe("audit des dépendances à la release", () => {
  test("tests-et-ci.md : pas de Dependabot, audit local, faille haute ou critique bloquante", () => {
    const doc = read(...REFS, "tests-et-ci.md");
    assert.match(doc, /Aucun `\.github\/dependabot\.yml`/);
    assert.match(doc, /haute ou critique/);
  });

  test("la release lance l'audit dans tous les modes et le corps de release le rapporte", () => {
    assert.match(read("skills", "gepet-squad", "SKILL.md"), /\*\*Audit des dépendances\*\*/);
    assert.match(read(...REFS, "mode-econome.md"), /audit des dépendances/);
    assert.match(read(...REFS, "github-conventions.md"), /- Audit des dépendances :/);
    assert.match(read(...REFS, "architecture-template.md"), /\| audit des dépendances \|/);
  });
});
