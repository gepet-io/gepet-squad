"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseCliArgs, run } = require("../../conso/cli.cjs");

function invalid(argv, re) {
  assert.throws(() => parseCliArgs(argv), (e) => re.test(e.message));
}

test("arguments : valeurs par défaut", () => {
  assert.deepEqual(parseCliArgs([]), { project: null, milestones: [], focus: null, format: "texte" });
});

test("arguments : --milestone répétable, entiers et F-<n>, titre contenant « = »", () => {
  const r = parseCliArgs(["--milestone", "M1=10,11", "--milestone", "M2 = a=b=F-07, #12", "--format", "json", "--focus", "M1", "--project", "x"]);
  assert.deepEqual(r.milestones, [
    { titre: "M1", issues: [10, 11] },
    { titre: "M2 = a=b", issues: ["F-07", 12] },
  ]);
  assert.equal(r.format, "json");
  assert.equal(r.focus, "M1");
  assert.equal(r.project, "x");
});

test("arguments invalides : milestone mal formé, identifiant, format, option inconnue, positionnel", () => {
  invalid(["--milestone", "M1"], /mal formé/);
  invalid(["--milestone", "=1"], /mal formé/);
  invalid(["--milestone", "M1=abc"], /ni entier ni F-/);
  invalid(["--milestone", "M1=0"], /ni entier ni F-/);
  invalid(["--milestone", "M1=1,,2"], /ni entier ni F-/);
  invalid(["--milestone", "M1=1", "--milestone", "M1=2"], /double/);
  invalid(["--format", "xml"], /--format/);
  invalid(["--inconnue"], /./);
  invalid(["positionnel"], /./);
});

test("--focus absent des --milestone : invalide", () => {
  invalid(["--focus", "M9"], /--focus/);
  invalid(["--milestone", "M1=1", "--focus", "M9"], /--focus/);
});

test("run : code 2 et message au format attendu sur stderr, rien sur stdout", async () => {
  let out = "";
  let err = "";
  const code = await run(["--format", "xml"], { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } });
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /^\[gepet-squad-conso\] erreur .+\n$/);
});

test("run : code 1 hors projet squad", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conso-nosquad-"));
  try {
    let err = "";
    const code = await run(["--project", dir], { stdout: { write() {} }, stderr: { write: (s) => (err += s) } });
    assert.equal(code, 1);
    assert.match(err, /^\[gepet-squad-conso\] erreur /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
