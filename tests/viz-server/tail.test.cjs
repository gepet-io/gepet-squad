// Tests de viz/lib/tail.cjs (suivi du journal par offset, identifiants de reprise) et du formatage SSE de
// viz/lib/http.cjs. Les fonctions pures sont testées sans disque ; createTail l'est sur un fichier temporaire, en
// appelant `poll()` à la main (aucune attente) puis, une fois, avec le vrai `fs.watchFile`.
const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  splitLines,
  parseJournalLine,
  isRotation,
  formatEventId,
  parseEventId,
  planResume,
  createTail,
} = require("../../viz/lib/tail.cjs");
const { SSE_EVENTS, formatSse, formatComment, createSseHub } = require("../../viz/lib/http.cjs");
const { createSseParser } = require("../helpers/index.cjs");

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

const SESSION = "5f3c1a9e-7b2d-4c6e-9a41-0d8e2b7f6c13";
let counter = 0;
/** Événement v1 valide ; chaque appel en produit un différent. */
function ev(extra = {}) {
  counter += 1;
  return {
    v: 1, ts: new Date(Date.UTC(2026, 9, 30, 12, 0, counter)).toISOString(), src: "hook", type: "agent.started",
    sessionId: SESSION, agentId: `a${counter}`, agentType: "claude-gepet-squad:developpeur", ...extra,
  };
}
const line = (event) => JSON.stringify(event) + "\n";
const buf = (text) => Buffer.from(text, "utf8");

// ---------------------------------------------------------------------------------------------------------------
// splitLines
// ---------------------------------------------------------------------------------------------------------------

describe("splitLines (unitaire)", () => {
  test("découpe en lignes complètes et donne l'offset qui suit chaque saut de ligne", () => {
    const { lines, consumed } = splitLines(buf("ab\ncde\nf\n"));
    assert.deepEqual(lines, [{ text: "ab", end: 3 }, { text: "cde", end: 7 }, { text: "f", end: 9 }]);
    assert.equal(consumed, 9);
  });

  test("une ligne partielle (sans \\n) n'est pas consommée", () => {
    const { lines, consumed } = splitLines(buf("ab\ncd"));
    assert.deepEqual(lines, [{ text: "ab", end: 3 }]);
    assert.equal(consumed, 3, "l'offset s'arrête avant « cd », relu au passage suivant");
  });

  test("aucun saut de ligne : rien n'est consommé", () => {
    assert.deepEqual(splitLines(buf("abc"), 40), { lines: [], consumed: 40 });
    assert.deepEqual(splitLines(buf(""), 7), { lines: [], consumed: 7 });
  });

  test("les offsets partent de startOffset", () => {
    const { lines, consumed } = splitLines(buf("x\ny\n"), 100);
    assert.deepEqual(lines, [{ text: "x", end: 102 }, { text: "y", end: 104 }]);
    assert.equal(consumed, 104);
  });

  test("CRLF : le \\r final est retiré du texte, mais compté dans l'offset", () => {
    const { lines, consumed } = splitLines(buf("a\r\nb\r\n"));
    assert.deepEqual(lines, [{ text: "a", end: 3 }, { text: "b", end: 6 }]);
    assert.equal(consumed, 6);
  });

  test("les offsets sont en octets, pas en caractères (UTF-8 multi-octets)", () => {
    const { lines, consumed } = splitLines(buf("é€\nà\n")); // é = 2 octets, € = 3 octets
    assert.deepEqual(lines, [{ text: "é€", end: 6 }, { text: "à", end: 9 }]);
    assert.equal(consumed, 9);
  });

  test("lignes vides conservées (texte vide), à ignorer par l'appelant", () => {
    const { lines } = splitLines(buf("a\n\nb\n"));
    assert.deepEqual(lines.map((l) => l.text), ["a", "", "b"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// parseJournalLine, isRotation
// ---------------------------------------------------------------------------------------------------------------

describe("parseJournalLine (unitaire)", () => {
  test("renvoie l'événement d'une ligne qui passe validate()", () => {
    const event = ev();
    assert.deepEqual(parseJournalLine(JSON.stringify(event)), event);
  });

  test("ignore (null) : ligne vide, JSON invalide, valeur non objet, champ inconnu, version ou type inconnus", () => {
    const mauvaises = [
      "", "   ", "pas du json", "{ coupé", "[1,2]", "null", '"texte"', "42",
      JSON.stringify({ ...ev(), inconnu: 1 }),
      JSON.stringify({ ...ev(), v: 2 }),
      JSON.stringify({ ...ev(), type: "agent.dance" }),
      JSON.stringify({ v: 1, src: "hook", type: "agent.started" }), // ts manquant
    ];
    for (const text of mauvaises) assert.equal(parseJournalLine(text), null, JSON.stringify(text));
    assert.equal(parseJournalLine(undefined), null);
  });

  test("le contrôle est celui de validate() (injectable)", () => {
    assert.equal(parseJournalLine('{"a":1}', () => ({ valid: true })).a, 1);
    assert.equal(parseJournalLine('{"a":1}', () => ({ valid: false })), null);
  });
});

describe("isRotation (unitaire)", () => {
  test("plus petit que l'offset déjà lu : rotation", () => {
    assert.equal(isRotation({ offset: 500 }, { size: 120 }), true);
    assert.equal(isRotation({ offset: 500 }, { size: 0 }), true);
  });

  test("même taille ou plus grand : pas de rotation", () => {
    assert.equal(isRotation({ offset: 500 }, { size: 500 }), false);
    assert.equal(isRotation({ offset: 500 }, { size: 900 }), false);
    assert.equal(isRotation({ offset: 0 }, { size: 0 }), false);
  });

  test("inode différent : fichier recréé, même s'il est déjà plus grand", () => {
    assert.equal(isRotation({ offset: 100, ino: 11n }, { size: 900, ino: 12n }), true);
    assert.equal(isRotation({ offset: 100, ino: 11n }, { size: 900, ino: 11n }), false);
  });

  test("inode inconnu (absent ou 0) : seule la taille compte", () => {
    assert.equal(isRotation({ offset: 100, ino: 0n }, { size: 900, ino: 12n }), false);
    assert.equal(isRotation({ offset: 100, ino: 11n }, { size: 900, ino: 0n }), false);
    assert.equal(isRotation({ offset: 100 }, { size: 900, ino: 12n }), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Identifiants de reprise
// ---------------------------------------------------------------------------------------------------------------

describe("formatEventId / parseEventId (unitaire)", () => {
  test("aller-retour", () => {
    assert.equal(formatEventId(3, 1280), "3:1280");
    assert.deepEqual(parseEventId("3:1280"), { generation: 3, offset: 1280 });
    assert.deepEqual(parseEventId(formatEventId(1730000000000, 0)), { generation: 1730000000000, offset: 0 });
    assert.deepEqual(parseEventId(" 2:5 "), { generation: 2, offset: 5 });
  });

  test("valeurs mal formées : null", () => {
    for (const value of [undefined, null, 12, "", "abc", "3", "3:", ":3", "3:4:5", "-1:4", "3:-4", "3:1.5", "a:b", "3: 4", "1e3:4", "99999999999999999:1"]) {
      assert.equal(parseEventId(value), null, String(value));
    }
  });
});

describe("planResume (unitaire)", () => {
  const position = { generation: 5, end: 1000 };

  test("sans Last-Event-ID : le flux seul, ni instantané ni rejeu", () => {
    for (const id of [undefined, null, ""]) assert.deepEqual(planResume(id, position), { snapshot: false, after: null });
  });

  test("génération courante : rejeu à partir de l'offset", () => {
    assert.deepEqual(planResume("5:400", position), { snapshot: false, after: 400 });
    assert.deepEqual(planResume("5:1000", position), { snapshot: false, after: 1000 });
    assert.deepEqual(planResume("5:0", position), { snapshot: false, after: 0 });
  });

  test("génération périmée, future, inconnue, mal formée ou offset au-delà de la fin : instantané", () => {
    for (const id of ["4:400", "6:400", "1:0", "abc", "5", "5:1001", "5:-1"]) {
      assert.deepEqual(planResume(id, position), { snapshot: true, after: null }, id);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Formatage SSE
// ---------------------------------------------------------------------------------------------------------------

describe("formatSse / formatComment (unitaire)", () => {
  test("format exact : id, event, data sur une ligne JSON, ligne vide finale", () => {
    assert.equal(
      formatSse({ event: "evt", id: "5:120", data: { a: 1, b: "x" } }),
      'id: 5:120\nevent: evt\ndata: {"a":1,"b":"x"}\n\n',
    );
  });

  test("sans id : pas de ligne id", () => {
    assert.equal(formatSse({ event: "warning", data: { code: "GH_AUTH" } }), 'event: warning\ndata: {"code":"GH_AUTH"}\n\n');
  });

  test("seuls evt, snapshot et warning sont acceptés ; l'alias `type` ne l'est pas", () => {
    assert.deepEqual([...SSE_EVENTS], ["evt", "snapshot", "warning"]);
    for (const event of SSE_EVENTS) assert.match(formatSse({ event, data: {} }), new RegExp(`^event: ${event}\\n`));
    for (const event of ["message", "event", "error", "", undefined, "EVT", "evt\ndata: x"]) {
      assert.throws(() => formatSse({ event, data: {} }), /hors contrat/, String(event));
    }
    assert.throws(() => formatSse({ type: "evt", data: {} }), /hors contrat/);
  });

  test("un id avec saut de ligne ou une data non sérialisable est refusé", () => {
    assert.throws(() => formatSse({ event: "evt", id: "1:2\nevent: x", data: {} }), /identifiant/);
    assert.throws(() => formatSse({ event: "evt", id: 12, data: {} }), /identifiant/);
    assert.throws(() => formatSse({ event: "evt", data: undefined }), /sérialisable/);
  });

  test("data reste sur une seule ligne, même avec des sauts de ligne et U+2028 dans les chaînes", () => {
    const data = { text: "a\nb\r\nc d e" };
    const message = formatSse({ event: "evt", id: "1:1", data });
    assert.equal(message.split("\n").filter((l) => l.startsWith("data:")).length, 1);
    assert.ok(!message.includes(" ") && !message.includes(" "));
    const [parsed] = createSseParser().feed(message);
    assert.deepEqual(JSON.parse(parsed.data), data, "le client retrouve exactement la valeur d'origine");
    assert.equal(parsed.event, "evt");
    assert.equal(parsed.id, "1:1");
  });

  test("le client SSE lit un flux de messages découpé n'importe où", () => {
    const flux = formatComment("connecté") + formatSse({ event: "evt", id: "1:10", data: { n: 1 } }) + formatComment("battement") + formatSse({ event: "snapshot", id: "1:10", data: { repo: "o/r" } });
    const parser = createSseParser();
    const out = [];
    for (let i = 0; i < flux.length; i += 7) out.push(...parser.feed(flux.slice(i, i + 7)));
    assert.deepEqual(out.map((m) => [m.event, m.id]), [["evt", "1:10"], ["snapshot", "1:10"]]);
  });

  test("formatComment : une ligne de commentaire, sans saut de ligne injecté", () => {
    assert.equal(formatComment("battement"), ": battement\n\n");
    assert.equal(formatComment("a\nevent: evt"), ": a event: evt\n\n");
    assert.deepEqual(createSseParser().feed(formatComment("x")), [], "un commentaire n'est pas un événement");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// createSseHub (faux flux de réponse : on compte les écouteurs et les écritures)
// ---------------------------------------------------------------------------------------------------------------

function fakeResponse() {
  const res = new EventEmitter();
  res.written = [];
  res.destroyed = false;
  res.writableEnded = false;
  res.writableLength = 0;
  res.socket = null;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.write = (text) => {
    res.written.push(text);
    return true;
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit("close");
  };
  return res;
}

describe("createSseHub (unitaire)", () => {
  test("open : en-têtes SSE avec CSP, accusé de connexion, messages initiaux avant toute diffusion", () => {
    const hub = createSseHub({ csp: "default-src 'self'" });
    const res = fakeResponse();
    hub.open(res, ["A", "B"]);
    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.headers["Content-Security-Policy"], "default-src 'self'");
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.ok(!Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-")));
    assert.equal(res.written.join(""), ": connecté\n\nAB");
    assert.equal(hub.size, 1);
    hub.close();
  });

  test("broadcast atteint tous les clients, et seulement ceux qui sont encore connectés", () => {
    const hub = createSseHub({ csp: "x" });
    const [a, b] = [fakeResponse(), fakeResponse()];
    hub.open(a);
    hub.open(b);
    hub.broadcast("M1");
    b.emit("close");
    hub.broadcast("M2");
    assert.deepEqual(a.written.slice(1), ["M1", "M2"]);
    assert.deepEqual(b.written.slice(1), ["M1"]);
    assert.equal(hub.size, 1);
    hub.close();
  });

  test("20 connexions/déconnexions : aucun client ni écouteur ne reste", () => {
    const hub = createSseHub({ csp: "x" });
    const responses = [];
    for (let i = 0; i < 20; i += 1) {
      const res = fakeResponse();
      hub.open(res);
      responses.push(res);
    }
    assert.equal(hub.size, 20);
    for (const res of responses) res.emit("close");
    assert.equal(hub.size, 0);
    for (const res of responses) {
      assert.equal(res.listenerCount("close"), 0);
      assert.equal(res.listenerCount("error"), 0);
    }
    hub.broadcast("après");
    assert.ok(responses.every((res) => !res.written.includes("après")), "plus rien n'est écrit vers un client parti");
  });

  test("une erreur sur la réponse libère aussi le client", () => {
    const hub = createSseHub({ csp: "x" });
    const res = fakeResponse();
    hub.open(res);
    res.emit("error", new Error("ECONNRESET"));
    assert.equal(hub.size, 0);
    assert.equal(res.listenerCount("close"), 0);
  });

  test("un battement (commentaire) part à chaque période, tant qu'il y a des clients, puis le minuteur s'arrête", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const hub = createSseHub({ csp: "x", heartbeatMs: 15000 });
      const res = fakeResponse();
      hub.open(res);
      mock.timers.tick(14999);
      assert.equal(res.written.filter((t) => t.startsWith(": battement")).length, 0);
      mock.timers.tick(1);
      assert.equal(res.written.filter((t) => t.startsWith(": battement")).length, 1);
      mock.timers.tick(30000);
      assert.equal(res.written.filter((t) => t.startsWith(": battement")).length, 3);

      res.emit("close");
      const before = res.written.length;
      mock.timers.tick(60000);
      assert.equal(res.written.length, before, "plus de battement vers un client parti");
      hub.close();
    } finally {
      mock.timers.reset();
    }
  });

  test("un client qui n'écoute plus (tampon plein) est coupé", () => {
    const hub = createSseHub({ csp: "x", maxBufferedBytes: 1000 });
    const lent = fakeResponse();
    const bon = fakeResponse();
    hub.open(lent);
    hub.open(bon);
    lent.writableLength = 5000;
    hub.broadcast("M");
    assert.equal(lent.destroyed, true);
    assert.equal(hub.size, 1);
    assert.ok(bon.written.includes("M"));
    hub.close();
  });

  test("close coupe tous les clients", () => {
    const hub = createSseHub({ csp: "x" });
    const [a, b] = [fakeResponse(), fakeResponse()];
    hub.open(a);
    hub.open(b);
    hub.close();
    assert.ok(a.destroyed && b.destroyed);
    assert.equal(hub.size, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// createTail sur un fichier temporaire
// ---------------------------------------------------------------------------------------------------------------

function tailFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-tail-"));
  const file = path.join(dir, "events.jsonl");
  const rotatedFile = path.join(dir, "events.1.jsonl");
  const seen = { events: [], rotations: [], skipped: 0, errors: [] };
  const tail = createTail({
    file,
    rotatedFile,
    generation: 7,
    onEvent: (entry) => seen.events.push(entry),
    onRotate: (generation) => seen.rotations.push(generation),
    onSkip: (count) => (seen.skipped += count),
    onError: (error) => seen.errors.push(error),
    ...options,
  });
  cleanups.push(() => {
    tail.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, rotatedFile, seen, tail };
}

describe("createTail (fichier temporaire, poll manuel)", () => {
  test("lit les événements existants, avec génération et offset de fin de ligne", () => {
    const { file, seen, tail } = tailFixture();
    const [a, b] = [ev(), ev()];
    fs.writeFileSync(file, line(a) + line(b));
    tail.poll();
    assert.deepEqual(seen.events.map((e) => e.event), [a, b]);
    assert.deepEqual(seen.events.map((e) => e.generation), [7, 7]);
    assert.equal(seen.events[0].offset, Buffer.byteLength(line(a)));
    assert.equal(seen.events[1].offset, fs.statSync(file).size);
    assert.equal(tail.offset, fs.statSync(file).size);
    assert.equal(tail.generation, 7);
  });

  test("ne relit pas ce qui a déjà été lu : seuls les ajouts arrivent", () => {
    const { file, seen, tail } = tailFixture();
    fs.writeFileSync(file, line(ev()));
    tail.poll();
    tail.poll();
    assert.equal(seen.events.length, 1);
    const next = ev();
    fs.appendFileSync(file, line(next));
    tail.poll();
    assert.equal(seen.events.length, 2);
    assert.deepEqual(seen.events[1].event, next);
  });

  test("fichier absent au départ : rien, puis les événements arrivent à sa création", () => {
    const { file, seen, tail } = tailFixture();
    tail.poll();
    assert.equal(seen.events.length, 0);
    assert.deepEqual(seen.errors, []);
    fs.writeFileSync(file, line(ev()));
    tail.poll();
    assert.equal(seen.events.length, 1);
  });

  test("ligne partielle : attente du \\n, l'événement n'est émis qu'une fois la ligne complète", () => {
    const { file, seen, tail } = tailFixture();
    const first = ev();
    const second = ev();
    const text = JSON.stringify(second);
    fs.writeFileSync(file, line(first) + text.slice(0, 30));
    tail.poll();
    assert.equal(seen.events.length, 1, "la ligne incomplète n'est pas émise");
    assert.equal(tail.offset, Buffer.byteLength(line(first)), "l'offset reste avant la ligne partielle");
    assert.equal(seen.skipped, 0, "une ligne partielle n'est pas une ligne ignorée");

    fs.appendFileSync(file, text.slice(30, 80));
    tail.poll();
    assert.equal(seen.events.length, 1);

    fs.appendFileSync(file, text.slice(80) + "\n");
    tail.poll();
    assert.equal(seen.events.length, 2);
    assert.deepEqual(seen.events[1].event, second);
    assert.equal(seen.events[1].offset, fs.statSync(file).size);
  });

  test("un caractère multi-octets coupé en deux par la lecture ne casse pas la ligne", () => {
    const { file, seen, tail } = tailFixture();
    const event = ev({ label: "café – déjà vu €" });
    const bytes = Buffer.from(line(event), "utf8");
    const cut = bytes.indexOf(Buffer.from("é")) + 1; // au milieu du premier « é »
    fs.writeFileSync(file, bytes.subarray(0, cut));
    tail.poll();
    assert.equal(seen.events.length, 0);
    fs.appendFileSync(file, bytes.subarray(cut));
    tail.poll();
    assert.deepEqual(seen.events.map((e) => e.event), [event]);
    assert.equal(seen.events[0].offset, bytes.length, "l'offset est en octets");
  });

  test("les lignes qui ne passent pas validate() sont ignorées et comptées, les suivantes sont lues", () => {
    const { file, seen, tail } = tailFixture();
    const good1 = ev();
    const good2 = ev();
    fs.writeFileSync(
      file,
      line(good1) + "pas du json\n" + "\n" + line({ ...ev(), inconnu: true }) + line({ ...ev(), type: "agent.dance" }) + "[1]\n" + line(good2),
    );
    tail.poll();
    assert.deepEqual(seen.events.map((e) => e.event), [good1, good2]);
    assert.equal(seen.skipped, 4, "4 lignes non vides invalides ; la ligne vide n'est pas comptée");
    assert.equal(seen.events[1].offset, fs.statSync(file).size);
  });

  test("rotation : fichier recréé plus petit -> reprise à 0, génération suivante, nouvelle onRotate", () => {
    const { file, rotatedFile, seen, tail } = tailFixture();
    fs.writeFileSync(file, line(ev()) + line(ev()) + line(ev()));
    tail.poll();
    assert.equal(seen.events.length, 3);
    const before = tail.offset;

    fs.renameSync(file, rotatedFile); // comme appendEvent
    const fresh = ev();
    fs.writeFileSync(file, line(fresh));
    assert.ok(fs.statSync(file).size < before);
    tail.poll();

    assert.equal(tail.generation, 8);
    assert.deepEqual(seen.rotations, [8]);
    assert.equal(seen.events.length, 4);
    assert.deepEqual(seen.events[3].event, fresh);
    assert.equal(seen.events[3].generation, 8);
    assert.equal(seen.events[3].offset, Buffer.byteLength(line(fresh)), "l'offset repart de 0");
    assert.equal(tail.offset, Buffer.byteLength(line(fresh)));
  });

  test("rotation vers un fichier vide puis rempli : repart bien de 0", () => {
    const { file, rotatedFile, seen, tail } = tailFixture();
    fs.writeFileSync(file, line(ev()) + line(ev()));
    tail.poll();
    fs.renameSync(file, rotatedFile);
    fs.writeFileSync(file, "");
    tail.poll();
    assert.deepEqual(seen.rotations, [8]);
    assert.equal(tail.offset, 0);
    const fresh = ev();
    fs.appendFileSync(file, line(fresh));
    tail.poll();
    assert.deepEqual(seen.events.at(-1).event, fresh);
    assert.deepEqual(seen.rotations, [8], "une seule rotation");
  });

  test("à la rotation, ce qui restait à lire dans l'ancien fichier est rattrapé avec l'ancienne génération", () => {
    const { file, rotatedFile, seen, tail } = tailFixture();
    fs.writeFileSync(file, line(ev()));
    tail.poll();
    const lost = ev();
    fs.appendFileSync(file, line(lost)); // écrit juste avant la rotation, jamais vu par poll()
    fs.renameSync(file, rotatedFile);
    const fresh = ev();
    fs.writeFileSync(file, line(fresh));
    // Le nouveau fichier doit être plus petit que l'offset déjà lu pour que la taille seule détecte la rotation.
    assert.ok(fs.statSync(file).size < tail.offset + Buffer.byteLength(line(lost)));
    tail.poll();

    const events = seen.events.map((e) => e.event);
    assert.deepEqual(events.slice(1), [lost, fresh]);
    assert.equal(seen.events[1].generation, 7, "l'événement rattrapé garde l'ancienne génération");
    assert.equal(seen.events[2].generation, 8);
  });

  test("un événement de l'ancien fichier n'est pas rattrapé deux fois si le fichier précédent est sans rapport", () => {
    const { file, rotatedFile, seen, tail } = tailFixture();
    fs.writeFileSync(file, line(ev()) + line(ev()));
    tail.poll();
    // events.1.jsonl plus court que l'offset lu : ce n'est pas notre ancien fichier, rien à rattraper.
    fs.writeFileSync(rotatedFile, line(ev()));
    fs.writeFileSync(file, line(ev()));
    tail.poll();
    assert.equal(seen.events.length, 3);
    assert.equal(seen.rotations.length, 1);
  });

  test("du bruit sans fin de ligne (plus de 64 Ko) est sauté et ne bloque pas la suite", () => {
    const { file, seen, tail } = tailFixture();
    fs.writeFileSync(file, "x".repeat(70 * 1024));
    tail.poll();
    assert.equal(seen.skipped, 1);
    assert.equal(tail.offset, 70 * 1024);
    const next = ev();
    fs.appendFileSync(file, "\n" + line(next)); // le reste de la ligne de bruit, puis un vrai événement
    tail.poll();
    assert.deepEqual(seen.events.map((e) => e.event), [next]);
  });

  test("start lit le contenu existant puis suit les ajouts avec fs.watchFile", async () => {
    const { file, seen, tail } = tailFixture({ intervalMs: 30 });
    fs.writeFileSync(file, line(ev()));
    tail.start();
    assert.equal(seen.events.length, 1, "le contenu existant est lu de façon synchrone par start()");
    const next = ev();
    fs.appendFileSync(file, line(next));
    const deadline = Date.now() + 3000;
    while (seen.events.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen.events.map((e) => e.event).at(-1), next);

    tail.stop();
    fs.appendFileSync(file, line(ev()));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(seen.events.length, 2, "après stop(), plus rien n'est lu");
  });
});
