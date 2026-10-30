// Tests unitaires de hooks/lib/schema.cjs : types, champs autorisés, limite de 4 Ko.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  SCHEMA_VERSION,
  MAX_LINE_BYTES,
  EVENT_TYPES,
  ALLOWED_FIELDS,
  MAX_ID_LENGTH,
  isPlainObject,
  normalizeAgentId,
  validate,
} = require("../../hooks/lib/schema.cjs");

const TS = "2026-10-30T10:00:00.000Z";

function event(type, extra = {}) {
  return { v: 1, ts: TS, src: "hook", type, ...extra };
}

describe("liste des types v1", () => {
  test("contient exactement les 13 types de l'ARCHITECTURE § 6", () => {
    assert.deepEqual([...EVENT_TYPES].sort(), [
      "agent.finished",
      "agent.launched",
      "agent.reported",
      "agent.requested",
      "agent.started",
      "feature.retry",
      "feature.status",
      "issue.closed",
      "issue.created",
      "milestone.changed",
      "pr.merged",
      "pr.opened",
      "release.opened",
    ]);
    assert.equal(SCHEMA_VERSION, 1);
  });

  test("les champs autorisés couvrent ceux de l'ARCHITECTURE § 6 et ceux de l'ADR 0004", () => {
    for (const name of [
      "v", "ts", "src", "type", "sessionId", "toolUseId", "agentId", "agentType", "mode",
      "issue", "pr", "status", "verdict", "label", "ref", "block", "source", "attempt", "retry",
    ]) {
      assert.ok(ALLOWED_FIELDS.includes(name), `champ manquant : ${name}`);
    }
  });

  test("les listes exportées sont figées", () => {
    assert.throws(() => EVENT_TYPES.push("autre"), TypeError);
    assert.throws(() => ALLOWED_FIELDS.push("autre"), TypeError);
  });
});

describe("validate : événements conformes", () => {
  for (const type of EVENT_TYPES) {
    test(`accepte un événement minimal de type ${type}`, () => {
      assert.deepEqual(validate(event(type)), { valid: true, errors: [] });
    });
  }

  test("accepte un événement complet", () => {
    const full = event("agent.reported", {
      sessionId: "s1", toolUseId: "toolu_1", agentId: "abc", agentType: "claude-gepet-squad:testeur",
      mode: "IMPLEMENTATION", issue: 2, pr: 12, attempt: 1, status: "in-review", verdict: "PASS",
      label: "status:in-review", ref: "feature/2-x", block: "RAPPORT_TESTS", source: "stop",
    });
    assert.equal(validate(full).valid, true);
  });

  test("accepte retry entier >= 1 sur feature.retry, sans confondre avec attempt", () => {
    for (const retry of [1, 2, 3, 10]) {
      assert.deepEqual(validate(event("feature.retry", { issue: 3, retry })), { valid: true, errors: [] });
    }
    assert.equal(validate(event("feature.retry", { issue: 3, retry: 2, attempt: 1 })).valid, true);
  });

  test("ref est une chaîne pour chaque usage (branche, titre de milestone, numéro de milestone)", () => {
    assert.equal(validate(event("pr.opened", { issue: 3, ref: "feature/3-x" })).valid, true);
    assert.equal(validate(event("release.opened", { ref: "release/m1-socle" })).valid, true);
    assert.equal(validate(event("issue.created", { ref: "M1 — Socle" })).valid, true);
    assert.equal(validate(event("milestone.changed", { ref: "3", status: "closed" })).valid, true);
    assert.equal(validate(event("milestone.changed", { ref: 3 })).valid, false);
  });

  test("traite un champ undefined comme absent", () => {
    assert.equal(validate(event("agent.started", { agentId: undefined })).valid, true);
  });
});

describe("validate : rejets", () => {
  test("rejette un type inconnu", () => {
    const r = validate(event("agent.exploded"));
    assert.equal(r.valid, false);
    assert.match(r.errors.join("\n"), /type inconnu : agent\.exploded/);
  });

  test("rejette un champ inconnu, même de valeur anodine", () => {
    const r = validate(event("agent.started", { prompt: "x" }));
    assert.equal(r.valid, false);
    assert.match(r.errors.join("\n"), /champ inconnu : prompt/);
  });

  for (const name of ["content", "message", "last_assistant_message", "tool_input"]) {
    test(`rejette le champ interdit par la minimisation : ${name}`, () => {
      assert.equal(validate(event("agent.reported", { [name]: "texte" })).valid, false);
    });
  }

  for (const name of ["v", "ts", "src", "type"]) {
    test(`rejette l'absence du champ obligatoire ${name}`, () => {
      const e = event("agent.started");
      delete e[name];
      const r = validate(e);
      assert.equal(r.valid, false);
      assert.match(r.errors.join("\n"), new RegExp(`champ obligatoire manquant : ${name}`));
    });
  }

  test("rejette une mauvaise version, une mauvaise source de journal", () => {
    assert.equal(validate({ ...event("agent.started"), v: 2 }).valid, false);
    assert.equal(validate({ ...event("agent.started"), src: "gh" }).valid, false);
  });

  test("rejette les valeurs du mauvais type", () => {
    assert.equal(validate(event("agent.requested", { issue: "2" })).valid, false);
    assert.equal(validate(event("agent.requested", { issue: 2.5 })).valid, false);
    assert.equal(validate(event("agent.requested", { pr: -1 })).valid, false);
    assert.equal(validate(event("agent.started", { agentId: 12 })).valid, false);
    assert.equal(validate(event("agent.started", { agentId: "" })).valid, false);
    assert.equal(validate(event("agent.started", { agentId: null })).valid, false);
    assert.equal(validate(event("agent.finished", { source: "autre" })).valid, false);
  });

  test("rejette retry s'il vaut 0, s'il est négatif ou s'il n'est pas un entier", () => {
    for (const retry of [0, -1, 1.5, "2", null, NaN, Infinity, true]) {
      const r = validate(event("feature.retry", { issue: 3, retry }));
      assert.equal(r.valid, false, String(retry));
      assert.match(r.errors.join("\n"), /retry doit être un entier supérieur ou égal à 1/);
    }
  });

  test("rejette tout ce qui n'est pas un objet, sans exception", () => {
    for (const value of [null, undefined, "texte", 42, [], [event("agent.started")], true]) {
      const r = validate(value);
      assert.equal(r.valid, false);
      assert.equal(r.errors.length, 1);
    }
  });

  test("cumule les erreurs", () => {
    const r = validate({ v: 1, src: "hook", type: "nope", extra: 1 });
    assert.equal(r.valid, false);
    assert.ok(r.errors.length >= 3, r.errors.join(" | "));
  });
});

describe("validate : horodatage ts", () => {
  test("accepte les dates ISO 8601 avec fuseau", () => {
    for (const ts of ["2026-10-30T10:00:00.000Z", "2026-10-30T10:00:00Z", "2026-10-30T12:00:00.5+02:00"]) {
      assert.equal(validate(event("agent.started", { ts })).valid, true, ts);
    }
  });

  test("rejette tout ce qui n'est pas une date ISO 8601", () => {
    for (const ts of ["hier", "2026-10-30", "2026-10-30 10:00:00", "30/10/2026", "2026-10-30T10:00:00", "2026-13-45T25:61:61Z", "1761818400000"]) {
      const r = validate(event("agent.started", { ts }));
      assert.equal(r.valid, false, ts);
      assert.match(r.errors.join("\n"), /ISO 8601/);
    }
    assert.equal(validate(event("agent.started", { ts: 1761818400000 })).valid, false);
  });
});

describe("isPlainObject", () => {
  test("distingue les objets des tableaux, de null et des scalaires", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
    for (const value of [null, undefined, [], "x", 1, true]) assert.equal(isPlainObject(value), false);
  });
});

describe("validate : limite de 4 Ko par ligne", () => {
  // Remplit `label` pour atteindre exactement `bytes` octets, saut de ligne compris.
  function eventOfSize(bytes) {
    const base = event("feature.status", { label: "" });
    const overhead = Buffer.byteLength(JSON.stringify({ ...base, label: "x" }) + "\n", "utf8") - 1;
    return { ...base, label: "x".repeat(bytes - overhead) };
  }

  test("accepte une ligne de 4096 octets exactement", () => {
    const e = eventOfSize(MAX_LINE_BYTES);
    assert.equal(Buffer.byteLength(JSON.stringify(e) + "\n", "utf8"), 4096);
    assert.deepEqual(validate(e), { valid: true, errors: [] });
  });

  test("rejette une ligne de 4097 octets", () => {
    const e = eventOfSize(MAX_LINE_BYTES + 1);
    assert.equal(Buffer.byteLength(JSON.stringify(e) + "\n", "utf8"), 4097);
    const r = validate(e);
    assert.equal(r.valid, false);
    assert.match(r.errors.join("\n"), /ligne trop longue/);
  });

  test("compte les octets et non les caractères (accents, émojis)", () => {
    // 'é' vaut 2 octets en UTF-8 : 2100 caractères dépassent 4096 octets sans dépasser 4096 caractères.
    const e = event("feature.status", { label: "é".repeat(2100) });
    assert.ok(JSON.stringify(e).length < MAX_LINE_BYTES);
    assert.equal(validate(e).valid, false);
  });
});

describe("normalizeAgentId", () => {
  test("retire le préfixe agent- et rend la même forme pour agent-xxx et xxx", () => {
    assert.equal(normalizeAgentId("agent-a4d2c8f1"), "a4d2c8f1");
    assert.equal(normalizeAgentId("a4d2c8f1"), "a4d2c8f1");
    assert.equal(normalizeAgentId("  agent-a4d2c8f1 "), "a4d2c8f1");
  });

  test("ne retire que le préfixe, une seule fois", () => {
    assert.equal(normalizeAgentId("agent-agent-x"), "agent-x");
    assert.equal(normalizeAgentId("my-agent-x"), "my-agent-x");
  });

  test("borne la longueur à 200 caractères, comme les autres identifiants", () => {
    assert.equal(MAX_ID_LENGTH, 200);
    assert.equal(normalizeAgentId("x".repeat(1000)).length, 200);
    assert.equal(normalizeAgentId("agent-" + "x".repeat(1000)), "x".repeat(200));
  });

  test("renvoie undefined pour tout ce qui n'est pas un identifiant", () => {
    for (const value of [undefined, null, 42, {}, "", "   ", "agent-"]) {
      assert.equal(normalizeAgentId(value), undefined);
    }
  });
});
