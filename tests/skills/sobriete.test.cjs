// Sobriété de contexte (ADR 0014) : le contrat vit dans des prompts Markdown. Ces tests échouent si une pièce
// (relais, relève, outils, voie légère, variante outillée, découpage du SKILL) disparaît ou se désaccorde.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const REFS = ["skills", "gepet-squad", "references"];
const tools = (agent) => /^tools: (.*)$/m.exec(read("agents", `${agent}.md`))[1].split(/,\s*/);

describe("outils des agents", () => {
  test("seule la variante outillée a l'outil Skill", () => {
    for (const agent of ["developpeur", "verificateur", "testeur"]) assert.ok(!tools(agent).includes("Skill"), agent);
    assert.ok(tools("developpeur-outille").includes("Skill"));
    assert.ok(!tools("verificateur").includes("Edit") && !tools("testeur").includes("Write"));
  });

  test("la variante outillée relit les instructions du développeur (une seule source)", () => {
    const text = read("agents", "developpeur-outille.md");
    assert.match(text, /<OUTILS>\/\.\.\/agents\/developpeur\.md/);
    assert.match(read("agents", "developpeur.md"), /`developpeur-outille`/);
  });

  for (const agent of ["developpeur", "verificateur", "testeur"]) {
    test(`${agent} : champ OUTILS, run-quiet.sh, rapport de secours`, () => {
      const text = read("agents", `${agent}.md`);
      assert.match(text, /`OUTILS`/);
      assert.match(text, /run-quiet\.sh/);
      assert.match(text, /\*\*Rapport refusé hors du worktree\*\*/);
    });
  }

  test("les agents qui lancent des tests n'attendent pas en arrière-plan", () => {
    for (const agent of ["developpeur", "testeur"]) assert.match(read("agents", `${agent}.md`), /jamais en arrière-plan/);
  });
});

describe("relais du développeur", () => {
  test("le développeur sait faire un relais et reprendre", () => {
    const text = read("agents", "developpeur.md");
    assert.match(text, /## Relais \(budget de contexte\)/);
    assert.match(text, /## MODE: REPRISE/);
    assert.match(text, /`Statut: RELAIS`/);
  });

  test("report-formats : statut RELAIS, note de relais, MODE REPRISE", () => {
    const doc = read(...REFS, "report-formats.md");
    assert.match(doc, /Statut: LIVRÉ \| BLOQUÉ \| RELAIS/);
    assert.match(doc, /### Note de relais/);
    assert.match(doc, /`REPRISE`/);
  });

  test("le CP relance en REPRISE sans compter d'échec, et la reprise retrouve les notes", () => {
    assert.match(read("skills", "gepet-squad", "SKILL.md"), /`Statut: RELAIS`[\s\S]*`MODE: REPRISE`/);
    assert.match(read("skills", "gepet-squad-resume", "SKILL.md"), /REPRISE/);
    assert.match(read(...REFS, "mode-econome.md"), /relais-1\.md/);
  });

  test("le hook de budget est déclaré en PostToolUse", () => {
    const hooks = JSON.parse(read("hooks", "hooks.json")).hooks.PostToolUse;
    assert.ok(hooks.some((h) => h.hooks.some((x) => x.command.includes("hooks/budget.cjs") && !x.async)));
  });
});

describe("relève et transitions du Chef de projet", () => {
  const skill = read("skills", "gepet-squad", "SKILL.md");

  test("relève à la fin du milestone, désactivable", () => {
    assert.match(skill, /## Relève du Chef de projet/);
    assert.match(skill, /`\/clear` puis `\/gepet-squad-resume`/);
    assert.match(skill.slice(skill.indexOf("## Phase 5")), /Relève du Chef de projet/);
    assert.match(read(...REFS, "github-conventions.md"), /"releve": "milestone" \| "aucune"/);
  });

  test("squad.cjs et run-quiet.sh sont cités et existent", () => {
    assert.match(skill, /squad\.cjs" etat/);
    assert.match(skill, /squad\.cjs" merge/);
    assert.match(skill, /run-quiet\.sh" --ci/);
    for (const f of ["squad.cjs", "run-quiet.sh"]) assert.ok(fs.existsSync(path.join(ROOT, "scripts", f)), f);
  });

  test("phases 1 à 3 déplacées dans cadrage.md, validations utilisateur comprises", () => {
    const cadrage = read(...REFS, "cadrage.md");
    for (const n of ["1", "2", "3"]) assert.match(cadrage, new RegExp(`^## Phase ${n} `, "m"));
    assert.match(cadrage, /Point de validation utilisateur n°1/);
    assert.match(cadrage, /Point de validation utilisateur n°2/);
    assert.doesNotMatch(skill, /^## Phase 1 /m);
    assert.match(skill, /`cadrage\.md`/);
  });

  test("tout subagent_type cité par le SKILL a son fichier d'agent", () => {
    for (const [, name] of skill.matchAll(/`gepet-squad:([a-z-]+)`/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, "agents", `${name}.md`)), name);
    }
  });
});

describe("voie légère", () => {
  test("règle d'or 2 : exception de la voie légère", () => {
    assert.match(read("skills", "gepet-squad", "SKILL.md"), /2\. Aucun merge sur `develop`[^\n]*\*\*sauf en voie légère\*\*/);
  });

  test("feature-template : mentions de taille et conditions", () => {
    const doc = read(...REFS, "feature-template.md");
    assert.match(doc, /S \| M \[· voie légère\] \[· outillé\]/);
    assert.match(doc, /8\. \*\*Mentions de taille\*\*/);
    assert.match(doc, /`sensitivePaths`/);
  });

  test("le testeur relit en voie légère et le rapport porte la relecture", () => {
    assert.match(read("agents", "testeur.md"), /## Voie légère \(`VOIE: legere`\)/);
    const doc = read(...REFS, "report-formats.md");
    assert.match(doc, /`VOIE`/);
    assert.match(doc, /— Relecture: <b> bloquant\(s\)/);
  });
});
