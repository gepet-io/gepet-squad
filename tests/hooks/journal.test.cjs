// Tests unitaires de hooks/lib/journal.cjs : calcul des chemins, décision de rotation, bornage du log,
// description des erreurs, puis les fonctions d'écriture sur des dossiers temporaires.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const journal = require("../../hooks/lib/journal.cjs");
const { createTempRepo, gitCommonDir } = require("../helpers/index.cjs");

const { MAX_JOURNAL_BYTES, MAX_LOG_BYTES } = journal;

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gepet-journal-")));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempRepo(options) {
  const repo = createTempRepo(options);
  cleanups.push(repo.cleanup);
  return repo;
}

describe("constantes", () => {
  test("rotation à 5 Mo, collector.log à 256 Ko", () => {
    assert.equal(MAX_JOURNAL_BYTES, 5 * 1024 * 1024);
    assert.equal(MAX_LOG_BYTES, 256 * 1024);
  });
});

describe("journalPaths : calcul du chemin", () => {
  test("tout vit dans <git-common-dir>/gepet-squad", () => {
    const common = path.join(path.sep, "projets", "demo", ".git");
    const paths = journal.journalPaths(common);
    assert.equal(paths.dir, path.join(common, "gepet-squad"));
    assert.equal(paths.events, path.join(common, "gepet-squad", "events.jsonl"));
    assert.equal(paths.rotated, path.join(common, "gepet-squad", "events.1.jsonl"));
    assert.equal(paths.log, path.join(common, "gepet-squad", "collector.log"));
  });
});

describe("shouldRotate : décision de rotation", () => {
  test("pas de rotation tant que la ligne tient dans les 5 Mo", () => {
    assert.equal(journal.shouldRotate(0, 200), false);
    assert.equal(journal.shouldRotate(1000, 200), false);
    assert.equal(journal.shouldRotate(MAX_JOURNAL_BYTES - 200, 200), false);
  });

  test("rotation dès que la ligne ferait dépasser 5 Mo", () => {
    assert.equal(journal.shouldRotate(MAX_JOURNAL_BYTES - 199, 200), true);
    assert.equal(journal.shouldRotate(MAX_JOURNAL_BYTES, 1), true);
    assert.equal(journal.shouldRotate(MAX_JOURNAL_BYTES + 1, 200), true);
  });

  test("un fichier vide n'est jamais tourné, même avec un seuil minuscule", () => {
    assert.equal(journal.shouldRotate(0, 500, 100), false);
  });

  test("le seuil est paramétrable", () => {
    assert.equal(journal.shouldRotate(90, 20, 100), true);
    assert.equal(journal.shouldRotate(80, 20, 100), false);
  });
});

describe("trimLog : bornage du log", () => {
  const line = (n) => `ligne ${String(n).padStart(3, "0")}\n`; // 10 octets

  test("un log sous la borne est renvoyé tel quel", () => {
    const text = line(1) + line(2);
    assert.equal(journal.trimLog(text, 100), text);
  });

  test("un log pile à la borne est renvoyé tel quel", () => {
    const text = line(1) + line(2);
    assert.equal(journal.trimLog(text, 20), text);
  });

  test("garde les lignes les plus récentes, entières, sous la borne", () => {
    const text = [1, 2, 3, 4, 5].map(line).join("");
    assert.equal(journal.trimLog(text, 25), line(4) + line(5));
    assert.equal(journal.trimLog(text, 30), line(3) + line(4) + line(5));
  });

  test("ne coupe jamais une ligne en deux", () => {
    const text = [1, 2, 3].map(line).join("");
    // 15 octets : la coupe tombe au milieu de la ligne 2, qui est donc supprimée.
    assert.equal(journal.trimLog(text, 15), line(3));
  });

  test("ne coupe pas un caractère multi-octets en deux", () => {
    const text = "éééééé\nàà\n"; // 13 + 5 octets
    const bounded = journal.trimLog(text, 8);
    assert.equal(bounded, "àà\n");
    assert.doesNotMatch(bounded, /�/);
  });

  test("une unique ligne plus grande que la borne donne un log vide", () => {
    assert.equal(journal.trimLog("x".repeat(500) + "\n", 100), "");
  });

  test("le résultat tient toujours dans la borne par défaut de 256 Ko", () => {
    const text = Array.from({ length: 20000 }, (_, i) => `2026-10-30T10:00:00.000Z erreur numéro ${i}\n`).join("");
    assert.ok(Buffer.byteLength(text) > MAX_LOG_BYTES);
    const bounded = journal.trimLog(text);
    assert.ok(Buffer.byteLength(bounded) <= MAX_LOG_BYTES);
    assert.ok(bounded.endsWith("erreur numéro 19999\n"));
    assert.ok(bounded.startsWith("2026-"), "la première ligne conservée est complète");
  });
});

describe("describeError et formatLogLine", () => {
  test("describeError garde le code et l'appel système, jamais le message", () => {
    const error = Object.assign(new Error("contenu sensible"), { code: "EISDIR", syscall: "open" });
    assert.equal(journal.describeError(error), "EISDIR (open)");
    assert.equal(journal.describeError(new SyntaxError('Unexpected token \'x\', "SECRET" is not valid JSON')), "SyntaxError");
    assert.equal(journal.describeError(null), "erreur inconnue");
    assert.equal(journal.describeError("texte"), "erreur inconnue");
  });

  test("formatLogLine : horodatage ISO, une seule ligne, longueur bornée", () => {
    const date = new Date("2026-10-30T10:00:00.000Z");
    assert.equal(journal.formatLogLine(date, "a\nb\r\nc"), "2026-10-30T10:00:00.000Z a b c\n");
    const long = journal.formatLogLine(date, "x".repeat(5000));
    assert.ok(long.length < 600);
    assert.equal(long.split("\n").length, 2);
  });
});

describe("findSquadRoot : recherche de .gepet-squad.json en remontant", () => {
  test("trouve le dossier courant et les dossiers parents", () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, ".gepet-squad.json"), "{}");
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(journal.findSquadRoot(root), root);
    assert.equal(journal.findSquadRoot(deep), root);
  });

  test("sans fichier de config, renvoie null", () => {
    const root = tempDir();
    assert.equal(journal.findSquadRoot(root), null);
  });
});

describe("resolveCommonDir et locateJournal", () => {
  test("le repo principal et son worktree partagent le même dossier commun", () => {
    const repo = tempRepo({ withWorktree: true });
    const fromMain = journal.resolveCommonDir(repo.dir);
    const fromWorktree = journal.resolveCommonDir(repo.worktreeDir);
    assert.equal(fs.realpathSync.native(fromWorktree), fs.realpathSync.native(fromMain));
    assert.equal(fs.realpathSync.native(fromMain), gitCommonDir(repo.dir));
  });

  test("hors d'un repo git, resolveCommonDir lève", () => {
    assert.throws(() => journal.resolveCommonDir(tempDir()));
  });

  test("locateJournal renvoie les chemins du journal commun dans un projet squad", () => {
    const repo = tempRepo({ withWorktree: true });
    fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), "{}");
    fs.writeFileSync(path.join(repo.worktreeDir, ".gepet-squad.json"), "{}");
    const main = journal.locateJournal(repo.dir);
    const wt = journal.locateJournal(repo.worktreeDir);
    // Le dossier gepet-squad n'existe pas encore : on compare son parent, qui est le dossier commun de git.
    assert.equal(path.basename(main.dir), "gepet-squad");
    assert.equal(path.basename(wt.events), "events.jsonl");
    assert.equal(fs.realpathSync.native(path.dirname(main.dir)), gitCommonDir(repo.dir));
    assert.equal(fs.realpathSync.native(path.dirname(wt.dir)), gitCommonDir(repo.dir));
  });

  test("locateJournal renvoie null hors d'un projet squad, sans rien créer", () => {
    const repo = tempRepo();
    assert.equal(journal.locateJournal(repo.dir), null);
    assert.equal(journal.locateJournal(""), null);
    assert.equal(journal.locateJournal(undefined), null);
    assert.equal(fs.existsSync(path.join(repo.dir, ".git", "gepet-squad")), false);
  });
});

describe("appendEvent : écriture et rotation", () => {
  const event = (n) => ({ v: 1, ts: "2026-10-30T10:00:00.000Z", src: "hook", type: "feature.status", issue: n, status: "done" });

  const LINE_BYTES = Buffer.byteLength(JSON.stringify(event(1)) + "\n");

  test("crée le dossier et ajoute une ligne JSON par événement", () => {
    const paths = journal.journalPaths(path.join(tempDir(), ".git"));
    journal.appendEvent(paths, event(1));
    journal.appendEvent(paths, event(2));
    const lines = fs.readFileSync(paths.events, "utf8").split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[2], "");
    assert.deepEqual(JSON.parse(lines[0]), event(1));
    assert.deepEqual(JSON.parse(lines[1]), event(2));
  });

  test("au-delà du seuil, events.jsonl devient events.1.jsonl et un nouveau fichier démarre", () => {
    const paths = journal.journalPaths(path.join(tempDir(), ".git"));
    const options = { maxBytes: LINE_BYTES * 3 + 5 }; // trois lignes tiennent, la quatrième fait tourner
    for (let n = 1; n <= 3; n += 1) journal.appendEvent(paths, event(n), options);
    const first = fs.readFileSync(paths.events, "utf8");
    assert.equal(first.trim().split("\n").length, 3);

    for (let n = 4; n <= 6; n += 1) journal.appendEvent(paths, event(n), options);
    const issues = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).issue);
    const rotated = issues(paths.rotated);
    const current = issues(paths.events);
    assert.deepEqual([...rotated, ...current], [1, 2, 3, 4, 5, 6]);
    assert.ok(rotated.length > 0 && current.length > 0);
    assert.ok(fs.statSync(paths.events).size <= options.maxBytes);
    assert.deepEqual(fs.readdirSync(paths.dir).sort(), ["events.1.jsonl", "events.jsonl"]);
  });

  test("un seul ancien fichier est conservé : une seconde rotation remplace events.1.jsonl", () => {
    const paths = journal.journalPaths(path.join(tempDir(), ".git"));
    const options = { maxBytes: LINE_BYTES * 2 + 5 };
    for (let n = 1; n <= 12; n += 1) journal.appendEvent(paths, event(n), options);
    assert.deepEqual(fs.readdirSync(paths.dir).sort(), ["events.1.jsonl", "events.jsonl"]);
    const first = JSON.parse(fs.readFileSync(paths.rotated, "utf8").split("\n")[0]).issue;
    assert.ok(first > 1, `les plus anciens événements ont disparu (premier restant : ${first})`);
  });

  test("lève si events.jsonl est inutilisable (l'appelant trace dans collector.log)", () => {
    const paths = journal.journalPaths(path.join(tempDir(), ".git"));
    fs.mkdirSync(paths.events, { recursive: true });
    assert.throws(() => journal.appendEvent(paths, event(1)));
  });
});

describe("appendLog : collector.log borné", () => {
  test("ajoute une ligne horodatée", () => {
    const paths = journal.journalPaths(path.join(tempDir(), ".git"));
    journal.appendLog(paths, "problème\nsur deux lignes");
    const text = fs.readFileSync(paths.log, "utf8");
    assert.match(text, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z problème sur deux lignes\n$/);
  });

  test("reste sous la borne en supprimant les lignes les plus anciennes", () => {
    const paths = journal.journalPaths(path.join(tempDir(), ".git"));
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.log, "ancienne ligne\n".repeat(100));
    journal.appendLog(paths, "dernière erreur", { maxBytes: 200 });
    const text = fs.readFileSync(paths.log, "utf8");
    assert.ok(Buffer.byteLength(text) <= 200);
    assert.ok(text.trimEnd().endsWith("dernière erreur"));
    assert.ok(text.includes("ancienne ligne"));
  });

  test("avec la borne par défaut de 256 Ko", () => {
    const paths = journal.journalPaths(path.join(tempDir(), ".git"));
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.log, "x".repeat(99) + "\n".repeat(1) + ("y".repeat(99) + "\n").repeat(5000));
    journal.appendLog(paths, "fin");
    const size = fs.statSync(paths.log).size;
    assert.ok(size <= MAX_LOG_BYTES, `taille ${size}`);
    assert.ok(size > MAX_LOG_BYTES - 300, "on garde le maximum de lignes récentes");
  });
});
