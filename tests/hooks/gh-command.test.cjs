// Tests unitaires de hooks/lib/gh-command.cjs : une fixture par commande de github-conventions.md et de
// SKILL.md, les chaînages, les guillemets, les heredocs et les entrées sans intérêt. Chaque événement produit
// doit aussi passer validate().
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ghCommandToEvents, splitCommandLine } = require("../../hooks/lib/gh-command.cjs");
const { validate } = require("../../hooks/lib/schema.cjs");

const FIXTURES = path.join(__dirname, "..", "fixtures", "gh");
const NOW = "2026-10-30T10:00:00.000Z";

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
}

function run(command, options) {
  const events = ghCommandToEvents(command, { now: NOW, ...options });
  for (const event of events) {
    assert.deepEqual(validate(event), { valid: true, errors: [] }, JSON.stringify(event));
  }
  return events;
}

// Événement complet attendu : les champs communs plus ceux du cas.
function ev(type, fields) {
  return { v: 1, ts: NOW, src: "hook", type, ...fields };
}

describe("fixtures : événements attendus pour chaque commande", () => {
  const cases = [
    ["issue-edit-status", [ev("feature.status", { issue: 12, status: "in-progress" })]],
    ["issue-edit-retry", [ev("feature.retry", { issue: 12, retry: 2 })]],
    [
      "issue-edit-labels-csv",
      [ev("feature.status", { issue: 12, status: "changes-requested" }), ev("feature.retry", { issue: 12, retry: 2 })],
    ],
    // Seul `--add-label` compte : retirer des labels (status:in-test, retry:*) ne produit rien.
    ["issue-edit-done-cleanup", [ev("feature.status", { issue: 12, status: "done" })]],
    ["issue-edit-body-file", []],
    ["issue-close", [ev("issue.closed", { issue: 12 })]],
    ["pr-merge", [ev("pr.merged", { pr: 34 })]],
    ["pr-create-feature", [ev("pr.opened", { issue: 12, ref: "feature/12-ajouter-une-tache" })]],
    ["pr-create-release", [ev("release.opened", { ref: "release/m1-socle" })]],
    ["issue-create", [ev("issue.created", { ref: "M1 — Socle", status: "ready" })]],
    ["milestone-close", [ev("milestone.changed", { ref: "3", status: "closed" })]],
    [
      "merge-flow",
      [
        ev("pr.merged", { pr: 34 }),
        ev("issue.closed", { issue: 12 }),
        ev("feature.status", { issue: 12, status: "done" }),
      ],
    ],
    // Commandes de la squad qui ne sont pas suivies.
    ["milestone-create", []],
    ["pr-close", []],
    ["pr-comment-heredoc", []],
    ["read-only", []],
    ["doc-placeholders", []],
  ];
  for (const [name, expected] of cases) {
    test(name, () => {
      assert.deepEqual(run(fixture(name)), expected);
    });
  }

  test("toutes les fixtures sont couvertes par un cas", () => {
    const covered = new Set(cases.map(([name]) => `${name}.txt`));
    const onDisk = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".txt"));
    assert.deepEqual(onDisk.filter((f) => !covered.has(f)), []);
  });
});

describe("feature.status et feature.retry", () => {
  const table = [
    ["status seul, sans --remove-label", "gh issue edit 5 --add-label status:ready", [ev("feature.status", { issue: 5, status: "ready" })]],
    ["--repo avant le numéro", "gh issue edit --repo o/r 5 --add-label status:blocked", [ev("feature.status", { issue: 5, status: "blocked" })]],
    ["-R et numéro #5 entre guillemets", 'gh issue edit "#5" -R o/r --add-label status:in-review', [ev("feature.status", { issue: 5, status: "in-review" })]],
    ["--add-label=valeur", "gh issue edit 5 --add-label=status:in-test", [ev("feature.status", { issue: 5, status: "in-test" })]],
    ["URL de l'issue", "gh issue edit https://github.com/o/r/issues/5 --add-label status:backlog", [ev("feature.status", { issue: 5, status: "backlog" })]],
    ["option répétée", "gh issue edit 5 --add-label status:done --add-label retry:3", [ev("feature.status", { issue: 5, status: "done" }), ev("feature.retry", { issue: 5, retry: 3 })]],
    ["liste entre guillemets avec espaces", 'gh issue edit 5 --add-label "retry:1, status:changes-requested"', [ev("feature.retry", { issue: 5, retry: 1 }), ev("feature.status", { issue: 5, status: "changes-requested" })]],
    [
      "plusieurs issues : un jeu d'événements par numéro",
      "gh issue edit 12 13 14 --add-label status:done,retry:1",
      [12, 13, 14].flatMap((issue) => [ev("feature.status", { issue, status: "done" }), ev("feature.retry", { issue, retry: 1 })]),
    ],
    ["plusieurs issues sans label suivi", "gh issue edit 12 13 --remove-label status:ready", []],
    ["statut inconnu","gh issue edit 5 --add-label status:bizarre", []],
    ["label sans rapport", "gh issue edit 5 --add-label type:feature,scope:hooks", []],
    ["retry non numérique", "gh issue edit 5 --add-label retry:x", []],
    ["retry:0 n'est pas un échec (le schéma exige retry >= 1)", "gh issue edit 5 --add-label retry:0", []],
    ["numéro d'issue absent", "gh issue edit --add-label status:ready", []],
    ["numéro d'issue invalide", "gh issue edit abc --add-label status:ready", []],
    ["label retiré seulement", "gh issue edit 5 --remove-label status:ready", []],
  ];
  for (const [name, command, expected] of table) {
    test(name, () => assert.deepEqual(run(command), expected));
  }
});

describe("pr, issue et milestone", () => {
  const table = [
    ["pr create sans issue dans la branche", "gh pr create --head fix/typo --base develop", [ev("pr.opened", { ref: "fix/typo" })]],
    ["pr create --head=valeur", "gh pr create --head=feature/9-x", [ev("pr.opened", { issue: 9, ref: "feature/9-x" })]],
    ["pr create -H", "gh pr create -H feature/9-x -B develop", [ev("pr.opened", { issue: 9, ref: "feature/9-x" })]],
    ["pr create depuis un fork", "gh pr create --head octocat:feature/9-x", [ev("pr.opened", { issue: 9, ref: "feature/9-x" })]],
    ["feature/ sans numéro", "gh pr create --head feature/sans-numero", [ev("pr.opened", { ref: "feature/sans-numero" })]],
    ["pr create sans --head", "gh pr create --fill", []],
    // Expansions shell non développées : la valeur n'est pas connue, on n'émet rien.
    ["--head avec variable", 'gh pr create --head "$BRANCH" --base develop', []],
    ["--head avec ${variable}", "gh pr create --head ${BRANCH} --base develop", []],
    ["--head avec $(commande)", 'gh pr create --head "$(git branch --show-current)" --base develop', []],
    ["--head avec $(commande) sans guillemets", "gh pr create --head $(git branch --show-current) --base develop", []],
    ["--head avec accents graves", "gh pr create --head `git branch --show-current` --base develop", []],
    ["--head partiellement développé", 'gh pr create --head "feature/12-$SLUG"', []],
    ["--milestone avec variable", 'gh issue create --title x --milestone "$M"', []],
    ["--milestone avec $(commande)", 'gh issue create --title x --milestone "$(cat m.txt)"', []],
    ["pr merge avec --match-head-commit avant le numéro", "gh pr merge --match-head-commit 1234567 34 --squash", [ev("pr.merged", { pr: 34 })]],
    ["pr merge avec --subject et -A", 'gh pr merge --subject "feat: x (#34)" -A a@b.c 34', [ev("pr.merged", { pr: 34 })]],
    ["pr merge avec --body-file avant le numéro", "gh pr merge --body-file 99 34", [ev("pr.merged", { pr: 34 })]],
    ["pr merge #34", 'gh pr merge "#34" --squash', [ev("pr.merged", { pr: 34 })]],
    ["pr merge par URL", "gh pr merge https://github.com/o/r/pull/34 --squash", [ev("pr.merged", { pr: 34 })]],
    ["pr merge sans numéro", "gh pr merge --squash --delete-branch", []],
    ["issue close sans numéro", "gh issue close --repo o/r", []],
    ["issue create sans milestone : ref est obligatoire", 'gh issue create --title "x"', []],
    ["issue create -m", 'gh issue create -t x -m "M2 — Suite"', [ev("issue.created", { ref: "M2 — Suite" })]],
    ["alias gh issue new", "gh issue new --title x --milestone M2", [ev("issue.created", { ref: "M2" })]],
    ["issue create avec un label de statut", 'gh issue create -m M2 -l "type:tech" -l status:backlog', [ev("issue.created", { ref: "M2", status: "backlog" })]],
    ["issue create avec un statut inconnu", "gh issue create -m M2 --label status:bizarre", [ev("issue.created", { ref: "M2" })]],
    ["issue create avec milestone vide", 'gh issue create --title x --milestone ""', []],
    ["milestone rouvert", "gh api -X PATCH repos/o/r/milestones/3 -f state=open", [ev("milestone.changed", { ref: "3", status: "open" })]],
    ["--method et slash initial", "gh api --method PATCH /repos/o/r/milestones/7 -F state=closed", [ev("milestone.changed", { ref: "7", status: "closed" })]],
    ["méthode en minuscules", "gh api -X patch repos/o/r/milestones/3 -f state=closed", [ev("milestone.changed", { ref: "3", status: "closed" })]],
    ["PATCH sans state", "gh api -X PATCH repos/o/r/milestones/3 -f title=Nouveau", [ev("milestone.changed", { ref: "3" })]],
    ["state inconnu", "gh api -X PATCH repos/o/r/milestones/3 -f state=bizarre", [ev("milestone.changed", { ref: "3" })]],
    ["GET d'un milestone", "gh api repos/o/r/milestones/3", []],
    ["PATCH d'une autre ressource", "gh api -X PATCH repos/o/r/issues/3 -f state=closed", []],
    ["gh api sans argument", "gh api", []],
  ];
  for (const [name, command, expected] of table) {
    test(name, () => assert.deepEqual(run(command), expected));
  }

  test("une branche très longue est tronquée et reste valide", () => {
    const [event] = run(`gh pr create --head feature/1-${"x".repeat(500)}`);
    assert.equal(event.type, "pr.opened");
    assert.equal(event.issue, 1);
    assert.equal(event.ref.length, 200);
  });
});

describe("commandes chaînées", () => {
  const edit = "gh issue edit 12 --add-label status:done";
  const close = "gh issue close 12";
  const events = [ev("feature.status", { issue: 12, status: "done" }), ev("issue.closed", { issue: 12 })];

  for (const [name, sep] of [["&&", " && "], ["||", " || "], [";", " ; "], ["retour à la ligne", "\n"], ["retour à la ligne CRLF", "\r\n"], ["|", " | "], ["& (arrière-plan)", " & "]]) {
    test(`séparateur ${name}`, () => assert.deepEqual(run(edit + sep + close), events));
  }

  test("sans espaces autour des séparateurs", () => {
    assert.deepEqual(run(`${edit}&&${close};gh pr merge 3`), [...events, ev("pr.merged", { pr: 3 })]);
  });

  test("un segment non gh ne perturbe pas les suivants", () => {
    assert.deepEqual(run(`cd /tmp && git status; ${edit}\nnpm test || ${close}`), events);
  });

  test("continuation de ligne avec un antislash", () => {
    assert.deepEqual(run("gh issue edit 12 \\\n  --add-label \\\n  status:done"), [events[0]]);
  });

  test("le séparateur dans des guillemets ne coupe pas", () => {
    const command = 'gh issue close 12 --comment "fini ; vérifié && mergé || ok\nbonsoir"';
    assert.deepEqual(run(command), [ev("issue.closed", { issue: 12 })]);
  });

  test("guillemets simples : le contenu reste littéral", () => {
    const command = "gh issue close 12 --comment 'a && gh issue close 99; \"b\"'";
    assert.deepEqual(run(command), [ev("issue.closed", { issue: 12 })]);
  });

  test("une commande gh dans le texte d'une autre commande n'est pas suivie", () => {
    assert.deepEqual(run('echo "gh issue close 99" && git commit -m \'gh pr merge 98; x\''), []);
    assert.deepEqual(run("git commit -m \"fix: gh issue close 99\" && gh pr merge 5"), [ev("pr.merged", { pr: 5 })]);
  });

  test("guillemets échappés dans une chaîne entre guillemets doubles", () => {
    assert.deepEqual(run('gh issue close 12 --comment "il a dit \\"fin\\" ; gh pr merge 98"'), [ev("issue.closed", { issue: 12 })]);
  });

  test("redirections : 2>&1 ne coupe pas la commande", () => {
    assert.deepEqual(run("gh issue close 12 2>&1 | cat"), [ev("issue.closed", { issue: 12 })]);
    assert.deepEqual(run("gh pr merge 3 &> /dev/null"), [ev("pr.merged", { pr: 3 })]);
  });

  test("commentaire de fin de ligne ignoré", () => {
    assert.deepEqual(run("gh issue close 12 # gh pr merge 98\ngh pr merge 3"), [ev("issue.closed", { issue: 12 }), ev("pr.merged", { pr: 3 })]);
  });

  test("heredoc : le corps n'est pas pris pour des commandes, la suite l'est", () => {
    const command = "gh issue create --milestone M1 --body-file - <<EOF\ngh pr merge 98\nEOF\ngh pr merge 3";
    assert.deepEqual(run(command), [ev("issue.created", { ref: "M1" }), ev("pr.merged", { pr: 3 })]);
  });

  test("heredoc <<- avec délimiteur indenté par des tabulations", () => {
    const command = "gh pr comment 3 --body-file - <<-'FIN'\n\tgh pr merge 98\n\tFIN\ngh pr merge 4";
    assert.deepEqual(run(command), [ev("pr.merged", { pr: 4 })]);
  });

  test("heredoc non terminé : tout le reste est du corps, sans exception", () => {
    assert.deepEqual(run("gh pr comment 3 --body-file - <<EOF\ngh pr merge 98"), []);
  });

  test("variable d'environnement et chemin de l'exécutable", () => {
    assert.deepEqual(run("GH_PROMPT_DISABLED=1 GH_TOKEN=x gh pr merge 3"), [ev("pr.merged", { pr: 3 })]);
    assert.deepEqual(run("/usr/bin/gh pr merge 3"), [ev("pr.merged", { pr: 3 })]);
    assert.deepEqual(run("gh.exe pr merge 3"), [ev("pr.merged", { pr: 3 })]);
  });

  test("le nom du programme doit être exactement gh", () => {
    assert.deepEqual(run("ugh pr merge 3"), []);
    assert.deepEqual(run("sh pr merge 3"), []);
  });
});

describe("options : sessionId et date", () => {
  test("sessionId recopié sur chaque événement", () => {
    const events = run("gh pr merge 3 && gh issue close 4", { sessionId: "sess-1" });
    assert.deepEqual(events.map((e) => e.sessionId), ["sess-1", "sess-1"]);
  });

  test("sans option : date de l'instant présent, valide", () => {
    const [event] = ghCommandToEvents("gh pr merge 3");
    assert.ok(Math.abs(Date.parse(event.ts) - Date.now()) < 5000);
    assert.equal(validate(event).valid, true);
  });

  test("date invalide : aucun événement non conforme n'est émis", () => {
    assert.deepEqual(ghCommandToEvents("gh pr merge 3", { now: "hier" }), []);
  });

  test("options non objet ignorées", () => {
    for (const options of [null, "x", 42, []]) {
      assert.equal(ghCommandToEvents("gh pr merge 3", options).length, 1);
    }
  });
});

describe("entrées sans intérêt : liste vide, sans exception", () => {
  const empty = [
    ["chaîne vide", ""],
    ["espaces", "  \n\t "],
    ["undefined", undefined],
    ["null", null],
    ["nombre", 42],
    ["objet", { command: "gh pr merge 3" }],
    ["tableau", ["gh", "pr", "merge", "3"]],
    ["commande non gh", "git push origin feature/3-x"],
    ["gh nu", "gh"],
    ["gh sans sous-commande", "gh pr"],
    ["groupe inconnu", "gh release create v1"],
    ["sous-commande inconnue", "gh issue frobnicate 3"],
    ["gh pr view", "gh pr view 3 --repo o/r"],
    ["gh issue list", "gh issue list --repo o/r --state all"],
    ["gh pr list", "gh pr list --base develop"],
    ["prototype d'objet", "gh constructor create"],
    ["prototype de sous-commande", "gh issue __proto__ 3"],
    ["prototype toString", "gh pr toString 3"],
    ["octets quelconques", "\u0000\u0007gh￿ pr \ud800 merge"],
  ];
  for (const [name, input] of empty) {
    test(name, () => assert.deepEqual(ghCommandToEvents(input, { now: NOW }), []));
  }

  test("guillemet non fermé : le mot ouvert est lu jusqu'à la fin", () => {
    assert.deepEqual(run('gh issue close "12'), [ev("issue.closed", { issue: 12 })]);
  });

  test("antislash final : ignoré", () => {
    assert.deepEqual(run("gh issue close 12 \\"), [ev("issue.closed", { issue: 12 })]);
  });

  test("redirection << sans mot : ignorée", () => {
    assert.deepEqual(run("gh issue close 12 <<"), [ev("issue.closed", { issue: 12 })]);
  });

  test("entrée très longue : traitée sans erreur", () => {
    const long = `gh issue close 12 --comment "${"x ; ".repeat(50000)}"`;
    assert.deepEqual(run(long), [ev("issue.closed", { issue: 12 })]);
  });
});

describe("splitCommandLine", () => {
  test("résout les guillemets et les échappements en mots", () => {
    assert.deepEqual(splitCommandLine(`a "b c" 'd e' f\\ g "h\\"i" ""`), [["a", "b c", "d e", "f g", 'h"i', ""]]);
  });

  test("découpe en segments", () => {
    assert.deepEqual(splitCommandLine("a b && c; d\ne"), [["a", "b"], ["c"], ["d"], ["e"]]);
  });
});

describe("cohérence avec guard.cjs", () => {
  test("les séparateurs du garde-fou découpent aussi ici", () => {
    // guard.cjs coupe sur /&&|\|\||;|\n/ : chacun de ces séparateurs doit isoler les commandes gh.
    for (const sep of ["&&", "||", ";", "\n"]) {
      const events = run(`gh pr merge 1 ${sep} gh pr merge 2`);
      assert.deepEqual(events.map((e) => e.pr), [1, 2], `séparateur ${JSON.stringify(sep)}`);
    }
  });
});
