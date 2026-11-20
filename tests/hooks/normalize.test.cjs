// Tests unitaires de hooks/lib/normalize.cjs : une fixture par type de payload, les cas null,
// la minimisation, la normalisation des identifiants et la limite de 4 Ko.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normalize, extractMission, extractReport } = require("../../hooks/lib/normalize.cjs");
const { validate, MAX_LINE_BYTES } = require("../../hooks/lib/schema.cjs");

const FIXTURES = path.join(__dirname, "..", "fixtures", "hooks");
const NOW = "2026-10-30T10:00:00.000Z";
const SESSION = "5f3c1a9e-7b2d-4c6e-9a41-0d8e2b7f6c13";

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

function run(payload) {
  return normalize(payload, { now: NOW });
}

describe("fixtures : événement attendu pour chaque payload", () => {
  test("PreToolUse Agent -> agent.requested avec mode, issue (et pr) extraits du prompt", () => {
    assert.deepEqual(run(fixture("pre-tool-use-agent")), {
      v: 1,
      ts: NOW,
      src: "hook",
      type: "agent.requested",
      sessionId: SESSION,
      toolUseId: "toolu_01Aq8Zp3Xv5Rk2Nm7Ls9Wd4T",
      agentType: "gepet-squad:developpeur",
      mode: "IMPLEMENTATION",
      issue: 7,
    });
  });

  test("PreToolUse Agent du vérificateur -> pr et attempt extraits, pas de mode", () => {
    assert.deepEqual(run(fixture("pre-tool-use-agent-verificateur")), {
      v: 1,
      ts: NOW,
      src: "hook",
      type: "agent.requested",
      sessionId: SESSION,
      toolUseId: "toolu_01Bc4Yq6Tn8Hj3Mp5Rw2Vx9K",
      agentType: "gepet-squad:verificateur",
      issue: 7,
      pr: 12,
      attempt: 2,
    });
  });

  test("PostToolUse Agent async_launched -> agent.launched qui relie toolUseId et agentId", () => {
    assert.deepEqual(run(fixture("post-tool-use-agent-async-launched")), {
      v: 1,
      ts: NOW,
      src: "hook",
      type: "agent.launched",
      sessionId: SESSION,
      toolUseId: "toolu_01Aq8Zp3Xv5Rk2Nm7Ls9Wd4T",
      agentId: "a4d2c8f1e0b3a297",
      agentType: "gepet-squad:developpeur",
    });
  });

  test("PostToolUse Agent completed -> agent.finished source tool", () => {
    assert.deepEqual(run(fixture("post-tool-use-agent-completed")), {
      v: 1,
      ts: NOW,
      src: "hook",
      type: "agent.finished",
      sessionId: SESSION,
      toolUseId: "toolu_01Bc4Yq6Tn8Hj3Mp5Rw2Vx9K",
      agentId: "b7e1f4a2c9d83056",
      agentType: "gepet-squad:verificateur",
      source: "tool",
    });
  });

  test("SubagentStart -> agent.started, identifiant sans le préfixe agent-", () => {
    assert.deepEqual(run(fixture("subagent-start")), {
      v: 1,
      ts: NOW,
      src: "hook",
      type: "agent.started",
      sessionId: SESSION,
      agentId: "a4d2c8f1e0b3a297",
      agentType: "gepet-squad:developpeur",
    });
  });

  test("SubagentStop -> agent.finished source stop, avec le verdict du message de clôture", () => {
    assert.deepEqual(run(fixture("subagent-stop")), {
      v: 1,
      ts: NOW,
      src: "hook",
      type: "agent.finished",
      sessionId: SESSION,
      agentId: "a4d2c8f1e0b3a297",
      agentType: "gepet-squad:developpeur",
      source: "stop",
      verdict: "LIVRÉ",
    });
  });

  test("PreToolUse SubagentHandback -> agent.reported avec block et verdict", () => {
    assert.deepEqual(run(fixture("pre-tool-use-subagent-handback")), {
      v: 1,
      ts: NOW,
      src: "hook",
      type: "agent.reported",
      sessionId: SESSION,
      agentId: "b7e1f4a2c9d83056",
      agentType: "gepet-squad:verificateur",
      block: "RAPPORT_VERIFICATION",
      verdict: "PASS",
    });
  });

  test("agent.reported ne porte pas de toolUseId : celui de SubagentHandback n'est pas celui de l'outil Agent", () => {
    const payload = fixture("pre-tool-use-subagent-handback");
    assert.equal(typeof payload.tool_use_id, "string");
    const e = run(payload);
    assert.equal(e.type, "agent.reported");
    assert.equal("toolUseId" in e, false);
    assert.equal(JSON.stringify(e).includes(payload.tool_use_id), false);
  });

  test("chaque événement produit est valide selon le schéma v1", () => {
    const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
    assert.equal(names.length, 7);
    for (const file of names) {
      const e = run(fixture(path.basename(file, ".json")));
      assert.notEqual(e, null, file);
      assert.deepEqual(validate(e), { valid: true, errors: [] }, file);
    }
  });

  test("chaque fixture porte une provenance stricte doc:<URL> ou capture:<version>, le commentaire va dans _note", () => {
    for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))) {
      const f = fixture(path.basename(file, ".json"));
      assert.match(f._provenance, /^(doc:https:\/\/\S+|capture:\S+)$/, file);
      assert.equal(typeof f._note, "string", `${file} : _note manquant`);
    }
  });

  test("accepte aussi le payload sous forme de texte JSON", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "subagent-start.json"), "utf8");
    assert.equal(run(text).type, "agent.started");
  });

  test("sans option now, horodate en ISO ; accepte un objet Date", () => {
    const auto = normalize(fixture("subagent-start"));
    assert.match(auto.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const dated = normalize(fixture("subagent-start"), { now: new Date("2026-01-02T03:04:05.000Z") });
    assert.equal(dated.ts, "2026-01-02T03:04:05.000Z");
  });

  test("l'ancien nom d'outil Task est accepté comme Agent", () => {
    const payload = { ...fixture("pre-tool-use-agent"), tool_name: "Task" };
    assert.equal(run(payload).type, "agent.requested");
    const post = { ...fixture("post-tool-use-agent-async-launched"), tool_name: "Task" };
    assert.equal(run(post).type, "agent.launched");
  });
});

describe("normalisation des identifiants d'agent", () => {
  test("agent-xxx et xxx donnent la même forme, dans tous les signaux", () => {
    const withPrefix = run({ ...fixture("subagent-start"), agent_id: "agent-a4d2c8f1e0b3a297" });
    const bare = run({ ...fixture("subagent-start"), agent_id: "a4d2c8f1e0b3a297" });
    assert.equal(withPrefix.agentId, "a4d2c8f1e0b3a297");
    assert.deepEqual(withPrefix, bare);

    const stopPrefixed = run({ ...fixture("subagent-stop"), agent_id: "agent-a4d2c8f1e0b3a297" });
    assert.equal(stopPrefixed.agentId, "a4d2c8f1e0b3a297");

    const launched = fixture("post-tool-use-agent-async-launched");
    const launchedPrefixed = run({
      ...launched,
      tool_response: { ...launched.tool_response, agentId: "agent-a4d2c8f1e0b3a297" },
    });
    assert.equal(launchedPrefixed.agentId, "a4d2c8f1e0b3a297");

    const handbackPrefixed = run({ ...fixture("pre-tool-use-subagent-handback"), agent_id: "agent-b7e1f4a2c9d83056" });
    assert.equal(handbackPrefixed.agentId, "b7e1f4a2c9d83056");
  });

  test("launched (agentId), started (agent_id préfixé) et finished (agent_id nu) se corrèlent", () => {
    const ids = [
      run(fixture("post-tool-use-agent-async-launched")).agentId,
      run(fixture("subagent-start")).agentId,
      run(fixture("subagent-stop")).agentId,
    ];
    assert.deepEqual(new Set(ids).size, 1, ids.join(", "));
  });
});

describe("cas null (sans exception)", () => {
  test("agent d'un autre plugin ou agent natif -> null, pour chaque signal", () => {
    for (const other of ["Explore", "general-purpose", "autre-plugin:developpeur", "claude-gepet-squad:", ""]) {
      const pre = fixture("pre-tool-use-agent");
      pre.tool_input.subagent_type = other;
      assert.equal(run(pre), null, `PreToolUse ${other}`);

      const post = fixture("post-tool-use-agent-completed");
      post.tool_input.subagent_type = other;
      assert.equal(run(post), null, `PostToolUse ${other}`);

      assert.equal(run({ ...fixture("subagent-start"), agent_type: other }), null, `SubagentStart ${other}`);
      assert.equal(run({ ...fixture("subagent-stop"), agent_type: other }), null, `SubagentStop ${other}`);
      assert.equal(run({ ...fixture("pre-tool-use-subagent-handback"), agent_type: other }), null, `Handback ${other}`);
    }
  });

  test("un SubagentStop interne (agent_type vide) -> null", () => {
    assert.equal(run({ ...fixture("subagent-stop"), agent_type: "" }), null);
    const sansType = fixture("subagent-stop");
    delete sansType.agent_type;
    assert.equal(run(sansType), null);
  });

  test("outil non suivi -> null", () => {
    for (const tool of ["Bash", "Read", "Write", "Edit", "Grep", "SubagentHandbackX", ""]) {
      assert.equal(run({ ...fixture("pre-tool-use-agent"), tool_name: tool }), null, tool);
      assert.equal(run({ ...fixture("post-tool-use-agent-completed"), tool_name: tool }), null, tool);
    }
  });

  test("événement de hook non suivi -> null", () => {
    for (const hook of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUseFailure", "Notification", undefined]) {
      assert.equal(run({ ...fixture("subagent-start"), hook_event_name: hook }), null, String(hook));
    }
  });

  test("PostToolUse SubagentHandback n'émet rien (évite le doublon avec PreToolUse)", () => {
    assert.equal(run({ ...fixture("pre-tool-use-subagent-handback"), hook_event_name: "PostToolUse" }), null);
  });

  test("statut d'agent inconnu ou absent -> null", () => {
    const base = fixture("post-tool-use-agent-completed");
    assert.equal(run({ ...base, tool_response: { ...base.tool_response, status: "failed" } }), null);
    const sansStatut = { ...base.tool_response };
    delete sansStatut.status;
    assert.equal(run({ ...base, tool_response: sansStatut }), null);
  });

  test("JSON incomplet ou champs manquants -> null", () => {
    const required = {
      "pre-tool-use-agent": ["tool_input", "tool_use_id"],
      "post-tool-use-agent-async-launched": ["tool_input", "tool_response", "tool_use_id"],
      "subagent-start": ["agent_id", "agent_type"],
      "subagent-stop": ["agent_id", "agent_type"],
      "pre-tool-use-subagent-handback": ["agent_id", "agent_type", "tool_input"],
    };
    for (const [name, fields] of Object.entries(required)) {
      for (const field of fields) {
        const payload = fixture(name);
        delete payload[field];
        assert.equal(run(payload), null, `${name} sans ${field}`);
      }
    }
    const launched = fixture("post-tool-use-agent-async-launched");
    delete launched.tool_response.agentId;
    assert.equal(run(launched), null, "launched sans agentId");

    const handback = fixture("pre-tool-use-subagent-handback");
    delete handback.tool_input.message;
    assert.equal(run(handback), null, "handback sans message");
  });

  test("texte JSON tronqué, vide ou invalide -> null", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "subagent-start.json"), "utf8");
    assert.equal(run(text.slice(0, text.length - 20)), null);
    assert.equal(run(""), null);
    assert.equal(run("pas du json"), null);
    assert.equal(run("[]"), null);
    assert.equal(run("null"), null);
  });

  test("entrées qui ne sont pas des objets -> null", () => {
    for (const value of [null, undefined, 42, true, [], [fixture("subagent-start")], () => 1]) {
      assert.equal(run(value), null);
    }
  });

  test("types inattendus dans un payload bien formé -> null, sans exception", () => {
    const base = fixture("pre-tool-use-agent");
    for (const bad of [null, 42, "texte", [], { subagent_type: 42 }, { subagent_type: ["claude-gepet-squad:x"] }]) {
      assert.doesNotThrow(() => run({ ...base, tool_input: bad }));
      assert.equal(run({ ...base, tool_input: bad }), null);
    }
    assert.equal(run({ ...fixture("subagent-start"), agent_id: { id: 1 } }), null);
    assert.equal(run({ ...fixture("subagent-start"), agent_id: "   " }), null);
    assert.equal(run({ ...fixture("subagent-start"), agent_id: "agent-" }), null);
  });
});

describe("extraction du prompt", () => {
  test("lit MODE, ISSUE, PR et TENTATIVE sur des lignes séparées", () => {
    assert.deepEqual(
      extractMission("MODE: CORRECTIF\nREPO: a/b\nISSUE: 12\nPR: #34\nBRANCHE: x\nTENTATIVE: 3"),
      { mode: "CORRECTIF", issue: 12, pr: 34, attempt: 3 },
    );
  });

  test("lit ISSUE quand la ligne contient d'autres champs, comme la mission du chef de projet", () => {
    assert.deepEqual(extractMission("ISSUE: 2 — SOUS_PROJET: hooks (hooks)"), {
      mode: undefined, issue: 2, pr: undefined, attempt: undefined,
    });
  });

  test("lit les modes de l'architecte", () => {
    assert.equal(extractMission("MODE: CADRAGE_QUESTIONS\nBESOIN: x").mode, "CADRAGE_QUESTIONS");
    assert.equal(extractMission("MODE: REVUE_ROADMAP").mode, "REVUE_ROADMAP");
  });

  test("ne confond pas MODE avec un champ qui se termine par MODE ou PR avec SOUS_PR", () => {
    assert.equal(extractMission("SOUS_MODE: X").mode, undefined);
    assert.equal(extractMission("SOUS_PR: 9").pr, undefined);
  });

  test("ne lit que les champs en début de ligne, pas ceux cités au milieu d'une phrase", () => {
    const m = extractMission("Voir le MODE: CORRECTIF et ISSUE: 99, PR: 98, TENTATIVE: 97 cités ci-dessus.\nISSUE: 5");
    assert.deepEqual(m, { mode: undefined, issue: 5, pr: undefined, attempt: undefined });
    assert.equal(extractMission("  MODE: IMPLEMENTATION").mode, "IMPLEMENTATION");
  });

  test("prend la première occurrence", () => {
    const m = extractMission("MODE: IMPLEMENTATION\nISSUE: 2\nPR: 5\nISSUE: 99\nPR: 98\nMODE: CORRECTIF");
    assert.deepEqual(m, { mode: "IMPLEMENTATION", issue: 2, pr: 5, attempt: undefined });
  });

  test("ignore ce qui suit les Notes et le RAPPORT recopié", () => {
    const prompt = "MODE: CORRECTIF\nISSUE: 2\nNotes :\nPR: 77\nTENTATIVE: 8";
    assert.deepEqual(extractMission(prompt), { mode: "CORRECTIF", issue: 2, pr: undefined, attempt: undefined });
    const withReport = "MODE: CORRECTIF\nISSUE: 2\nPR: 17\nRAPPORT:\nRAPPORT_VERIFICATION\nISSUE: 66\nPR: 55\nTENTATIVE: 1";
    assert.deepEqual(extractMission(withReport), { mode: "CORRECTIF", issue: 2, pr: 17, attempt: undefined });
  });

  test("lit une mission en fins de ligne Windows", () => {
    assert.deepEqual(extractMission("MODE: IMPLEMENTATION\r\nISSUE: 3\r\nPR: 4\r\n"), {
      mode: "IMPLEMENTATION", issue: 3, pr: 4, attempt: undefined,
    });
  });

  test("ignore un prompt absent, non texte ou sans champ", () => {
    for (const value of [undefined, null, 42, {}, "", "rien à extraire"]) {
      assert.deepEqual(extractMission(value), { mode: undefined, issue: undefined, pr: undefined, attempt: undefined });
    }
  });

  test("ne retient pas un mode en minuscules ni un numéro non numérique", () => {
    assert.equal(extractMission("MODE: implementation").mode, undefined);
    assert.equal(extractMission("ISSUE: abc").issue, undefined);
  });
});

describe("extraction du rapport", () => {
  test("RAPPORT_DEV : statut RELAIS (budget de contexte)", () => {
    const report = "RAPPORT_DEV\nStatut: RELAIS — Issue: #2 — PR: aucune — Branche: feature/2-x @abc1234 — tentative 0";
    assert.deepEqual(extractReport(report), { block: "RAPPORT_DEV", verdict: "RELAIS" });
  });

  test("RAPPORT_DEV : statut", () => {
    assert.deepEqual(extractReport("RAPPORT_DEV\nStatut: BLOQUÉ\nIssue: #2"), { block: "RAPPORT_DEV", verdict: "BLOQUÉ" });
    assert.deepEqual(extractReport("RAPPORT_DEV\nStatut: LIVRÉ"), { block: "RAPPORT_DEV", verdict: "LIVRÉ" });
  });

  test("format Output Flash : la ligne compacte ne laisse fuiter que le statut ou le verdict", () => {
    const dev = "RAPPORT_DEV\nStatut: LIVRÉ — Issue: #7 — PR: #12 — Branche: feature/7-x — tentative 0\nCritères: 3/3 — Tests: 10 passés / 0 échoués\nDifficultés: aucune\nDétail: https://github.com/o/r/pull/12#issuecomment-1";
    assert.deepEqual(extractReport(dev), { block: "RAPPORT_DEV", verdict: "LIVRÉ" });
    assert.deepEqual(extractReport("RAPPORT_DEV\nStatut: BLOQUÉ — Issue: #7 — PR: aucune — Branche: feature/7-x — tentative 0"), {
      block: "RAPPORT_DEV", verdict: "BLOQUÉ",
    });
    assert.deepEqual(extractReport("RAPPORT_VERIFICATION\nVerdict: FAIL — Issue: #7 — PR: #12 — tentative 1\nCorrectifs: 2\nDifficultés: aucune\nDétail: https://x"), {
      block: "RAPPORT_VERIFICATION", verdict: "FAIL",
    });
    assert.deepEqual(extractReport("RAPPORT_TESTS\nVerdict: PASS — Issue: #7 — PR: #12 — tentative 1\nTests: 12 passés / 0 échoués\nDifficultés: aucune\nDétail: https://x"), {
      block: "RAPPORT_TESTS", verdict: "PASS",
    });
  });

  test("RAPPORT_VERIFICATION et RAPPORT_TESTS : verdict sans le reste de la ligne", () => {
    assert.deepEqual(extractReport("RAPPORT_VERIFICATION\nVerdict: FAIL — PR #3 — tentative 2"), {
      block: "RAPPORT_VERIFICATION", verdict: "FAIL",
    });
    assert.deepEqual(extractReport("RAPPORT_TESTS\nVerdict: PASS — PR #3 — tentative 1\n### Résultats"), {
      block: "RAPPORT_TESTS", verdict: "PASS",
    });
  });

  test("VERDICT_ROADMAP : le verdict est sur l'en-tête", () => {
    assert.deepEqual(extractReport("VERDICT_ROADMAP: APPROUVÉ\n"), { block: "VERDICT_ROADMAP", verdict: "APPROUVÉ" });
    assert.deepEqual(extractReport("VERDICT_ROADMAP: À REVOIR\n1. [F-1] problème"), {
      block: "VERDICT_ROADMAP", verdict: "À REVOIR",
    });
  });

  test("blocs sans verdict", () => {
    assert.deepEqual(extractReport("QUESTIONS\n1. Quoi ? | header: x"), { block: "QUESTIONS", verdict: undefined });
    assert.deepEqual(extractReport("PITCH\n### Objectifs"), { block: "PITCH", verdict: undefined });
    assert.deepEqual(extractReport("ESCALADE\n### Diagnostic"), { block: "ESCALADE", verdict: undefined });
    assert.deepEqual(extractReport("PROPOSITION\n### Besoin compris"), { block: "PROPOSITION", verdict: undefined });
  });

  test("tolère une clôture de code, des lignes vides et du gras Markdown", () => {
    assert.deepEqual(extractReport("```\n\nRAPPORT_DEV\n**Statut:** LIVRÉ\n```"), {
      block: "RAPPORT_DEV", verdict: "LIVRÉ",
    });
    assert.deepEqual(extractReport("RAPPORT_TESTS\r\nVerdict: PASS — PR #1\r\n"), { block: "RAPPORT_TESTS", verdict: "PASS" });
  });

  test("un en-tête inconnu n'est jamais recopié", () => {
    const r = extractReport("Voici mon résumé confidentiel\nVerdict: PASS");
    assert.equal(r.block, undefined);
    assert.equal(r.verdict, "PASS");
  });

  test("un statut en minuscules (texte libre) n'est pas pris pour un verdict", () => {
    assert.equal(extractReport("Statut: en cours de revue").verdict, undefined);
  });

  test("seules les valeurs de verdict connues sont retenues", () => {
    assert.equal(extractReport("RAPPORT_TESTS\nVerdict: PASSED").verdict, undefined);
    assert.equal(extractReport("RAPPORT_TESTS\nVerdict: SECRET_TEXTE").verdict, undefined);
    assert.equal(extractReport("RAPPORT_TESTS\nVerdict: FAIL").verdict, "FAIL");
  });

  test("le premier verdict valide gagne", () => {
    assert.equal(extractReport("RAPPORT_DEV\nStatut: en cours\nStatut: LIVRÉ\nStatut: BLOQUÉ").verdict, "LIVRÉ");
  });

  test("texte absent ou non texte", () => {
    for (const value of [undefined, null, 42, {}, ""]) {
      assert.deepEqual(extractReport(value), value === "" ? { block: undefined, verdict: undefined } : {});
    }
  });
});

describe("agent.reported : cas limites", () => {
  test("message sans en-tête reconnu : événement émis, sans block", () => {
    const payload = fixture("pre-tool-use-subagent-handback");
    payload.tool_input.message = "texte libre sans bloc";
    const e = run(payload);
    assert.equal(e.type, "agent.reported");
    assert.equal(e.block, undefined);
    assert.equal(e.verdict, undefined);
    assert.equal("block" in e, false);
  });

  test("SubagentStop sans verdict dans le message de clôture : pas de champ verdict", () => {
    const payload = fixture("subagent-stop");
    payload.last_assistant_message = "Terminé.";
    const e = run(payload);
    assert.equal(e.source, "stop");
    assert.equal("verdict" in e, false);
  });

  test("SubagentStop sans last_assistant_message : événement émis", () => {
    const payload = fixture("subagent-stop");
    delete payload.last_assistant_message;
    assert.equal(run(payload).type, "agent.finished");
  });
});

describe("minimisation", () => {
  const MARKERS = [
    "SECRET_PROMPT_MARKER",
    "SECRET_CONTENT_MARKER",
    "SECRET_LAST_MESSAGE_MARKER",
    "SECRET_MESSAGE_MARKER",
  ];

  test("aucun événement ne contient le prompt, last_assistant_message, tool_input.message ni content", () => {
    const forbidden = [];
    for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))) {
      const payload = fixture(path.basename(file, ".json"));
      const serialized = JSON.stringify(run(payload));
      const texts = [
        payload.tool_input && payload.tool_input.prompt,
        payload.tool_input && payload.tool_input.message,
        payload.tool_input && payload.tool_input.description,
        payload.last_assistant_message,
        payload.tool_response && payload.tool_response.prompt,
        payload.tool_response && payload.tool_response.description,
        payload.tool_response && payload.tool_response.outputFile,
        ...((payload.tool_response && payload.tool_response.content) || []).map((c) => c.text),
        payload.transcript_path,
        payload.agent_transcript_path,
        payload.cwd,
      ].filter((t) => typeof t === "string");
      for (const text of texts) {
        assert.equal(serialized.includes(text), false, `${file} recopie : ${text.slice(0, 40)}`);
        forbidden.push(text);
      }
      for (const marker of MARKERS) {
        assert.equal(serialized.includes(marker), false, `${file} contient ${marker}`);
      }
    }
    // Garde-fou du test lui-même : les fixtures contiennent bien les textes à ne pas fuiter.
    const all = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))
      .map((f) => fs.readFileSync(path.join(FIXTURES, f), "utf8")).join("\n");
    for (const marker of MARKERS) assert.ok(all.includes(marker), `fixtures sans ${marker}`);
    assert.ok(forbidden.length > 10);
  });

  test("les champs de l'événement sont limités à la liste blanche, même si le payload en porte d'autres", () => {
    const payload = fixture("pre-tool-use-agent");
    payload.tool_input.message = "SECRET_MESSAGE_MARKER";
    payload.tool_input.content = "SECRET_CONTENT_MARKER";
    payload.content = "SECRET_CONTENT_MARKER";
    payload.last_assistant_message = "SECRET_LAST_MESSAGE_MARKER";
    const serialized = JSON.stringify(run(payload));
    for (const marker of MARKERS) assert.equal(serialized.includes(marker), false, marker);
    assert.deepEqual(Object.keys(run(payload)).sort(), [
      "agentType", "issue", "mode", "sessionId", "src", "toolUseId", "ts", "type", "v",
    ]);
  });

  test("un verdict ne laisse pas passer le texte qui le suit", () => {
    const payload = fixture("subagent-stop");
    payload.last_assistant_message = "RAPPORT_DEV\nStatut: LIVRÉ SECRET_LAST_MESSAGE_MARKER détaillé";
    const e = run(payload);
    assert.equal(e.verdict.includes("SECRET"), false);
    assert.equal(JSON.stringify(e).includes("SECRET_LAST_MESSAGE_MARKER"), false);
  });
});

describe("limite de 4 Ko", () => {
  test("un identifiant démesuré est tronqué et l'événement reste sous 4 Ko", () => {
    const payload = fixture("subagent-start");
    payload.session_id = "s".repeat(100000);
    const e = run(payload);
    assert.notEqual(e, null);
    assert.ok(Buffer.byteLength(JSON.stringify(e) + "\n") <= MAX_LINE_BYTES);
    assert.equal(e.sessionId.length, 200);
  });

  test("tous les identifiants d'agent sont tronqués à 200 caractères", () => {
    const start = run({ ...fixture("subagent-start"), agent_id: "a".repeat(5000) });
    assert.equal(start.agentId.length, 200);
    const launched = fixture("post-tool-use-agent-async-launched");
    const e = run({ ...launched, tool_response: { ...launched.tool_response, agentId: "agent-" + "b".repeat(5000) } });
    assert.equal(e.agentId, "b".repeat(200));
  });

  test("un prompt de 1 Mo ne fait ni exception ni fuite", () => {
    const payload = fixture("pre-tool-use-agent");
    payload.tool_input.prompt = "MODE: IMPLEMENTATION\nISSUE: 9\n" + "x".repeat(1_000_000);
    const e = run(payload);
    assert.equal(e.issue, 9);
    assert.ok(JSON.stringify(e).length < 1000);
  });
});

describe("préfixe des agents : nouveau (gepet-squad:) et ancien (claude-gepet-squad:)", () => {
  const LEGACY = "claude-gepet-squad:";
  const PREFIXES = ["gepet-squad:", LEGACY];
  const NOT_SQUAD = [
    "autre-plugin:architecte",
    "claude-gepet-squad-evil:x",
    "gepet-squad-evil:x",
    "xgepet-squad:developpeur",
    "claude-gepet-squad",
    "gepet-squad",
    "gepet-squad:",
    LEGACY,
  ];

  // Les fixtures portent l'ancien préfixe (payloads réels) ; on les rejoue aussi avec un autre préfixe.
  function withPrefix(name, prefix) {
    return JSON.parse(JSON.stringify(fixture(name)).replaceAll(LEGACY, prefix));
  }

  test("les fixtures d'origine portent bien l'ancien préfixe (garde-fou du test)", () => {
    assert.equal(fixture("subagent-start").agent_type, "claude-gepet-squad:developpeur");
    assert.equal(fixture("pre-tool-use-agent").tool_input.subagent_type, "claude-gepet-squad:developpeur");
  });

  for (const prefix of PREFIXES) {
    test(`${prefix} : chaque signal d'agent produit un événement dont le type porte le nouveau préfixe`, () => {
      const pre = run(withPrefix("pre-tool-use-agent", prefix));
      assert.equal(pre.type, "agent.requested");
      assert.equal(pre.agentType, "gepet-squad:developpeur");
      assert.equal(pre.issue, 7);

      const launched = run(withPrefix("post-tool-use-agent-async-launched", prefix));
      assert.equal(launched.type, "agent.launched");
      assert.equal(launched.agentType, "gepet-squad:developpeur");

      const completed = run(withPrefix("post-tool-use-agent-completed", prefix));
      assert.equal(completed.type, "agent.finished");
      assert.equal(completed.agentType, "gepet-squad:verificateur");

      const start = run(withPrefix("subagent-start", prefix));
      assert.equal(start.type, "agent.started");
      assert.equal(start.agentType, "gepet-squad:developpeur");

      const stop = run(withPrefix("subagent-stop", prefix));
      assert.equal(stop.type, "agent.finished");
      assert.equal(stop.source, "stop");
      assert.equal(stop.agentType, "gepet-squad:developpeur");

      const handback = run(withPrefix("pre-tool-use-subagent-handback", prefix));
      assert.equal(handback.type, "agent.reported");
      assert.equal(handback.agentType, "gepet-squad:verificateur");
    });
  }

  test("les deux préfixes donnent des événements identiques", () => {
    for (const name of ["pre-tool-use-agent", "post-tool-use-agent-async-launched", "subagent-start", "subagent-stop"]) {
      assert.deepEqual(run(withPrefix(name, "gepet-squad:")), run(withPrefix(name, LEGACY)), name);
    }
  });

  test("un autre plugin, un préfixe approchant ou un type vide -> null, pour chaque signal", () => {
    for (const other of NOT_SQUAD) {
      const pre = fixture("pre-tool-use-agent");
      pre.tool_input.subagent_type = other;
      assert.equal(run(pre), null, `PreToolUse ${other}`);

      const post = fixture("post-tool-use-agent-completed");
      post.tool_input.subagent_type = other;
      assert.equal(run(post), null, `PostToolUse ${other}`);

      assert.equal(run({ ...fixture("subagent-start"), agent_type: other }), null, `SubagentStart ${other}`);
      assert.equal(run({ ...fixture("subagent-stop"), agent_type: other }), null, `SubagentStop ${other}`);
      assert.equal(run({ ...fixture("pre-tool-use-subagent-handback"), agent_type: other }), null, `Handback ${other}`);
    }
  });
});
