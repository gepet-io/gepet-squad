// Tests de viz/public/js/sync.js : libellé de la connexion, et tri des événements déjà repris par `/state`.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PENDING_MESSAGES,
  REFLECTED_MARGIN_MS,
  connectionStatus,
  dropReflected,
  reflectedCutoff,
} from "../../viz/public/js/sync.js";
import { T0, at, ev, evt, snapshotMsg, stateOf } from "./support.mjs";

describe("connectionStatus", () => {
  test("ouverte -> connecté", () => {
    assert.deepEqual(connectionStatus(1, false), { state: "open", text: "connecté" });
    assert.deepEqual(connectionStatus(1, true), { state: "open", text: "connecté" });
  });

  test("en cours de connexion : « connexion » la première fois, « reconnexion » ensuite", () => {
    assert.deepEqual(connectionStatus(0, false), { state: "connecting", text: "connexion…" });
    assert.deepEqual(connectionStatus(0, true), { state: "reconnecting", text: "reconnexion…" });
  });

  test("fermée (le navigateur ne réessaiera plus) ou état inconnu -> déconnecté", () => {
    assert.deepEqual(connectionStatus(2, true), { state: "closed", text: "déconnecté" });
    assert.deepEqual(connectionStatus(7, true), { state: "closed", text: "déconnecté" });
    assert.deepEqual(connectionStatus(undefined, false), { state: "closed", text: "déconnecté" });
  });
});

describe("reflectedCutoff", () => {
  test("date de l'état moins la marge ; date inconnue -> null", () => {
    assert.equal(reflectedCutoff(at(0)), T0 - REFLECTED_MARGIN_MS);
    assert.equal(reflectedCutoff(at(0), 0), T0);
    assert.equal(reflectedCutoff(T0, 500), T0 - 500);
    for (const bad of [null, undefined, "", "pas une date", 12n]) assert.equal(reflectedCutoff(bad), null, String(bad));
  });

  test("la marge couvre le délai de suivi du journal (500 ms) du serveur", () => {
    assert.ok(REFLECTED_MARGIN_MS >= 1000);
    assert.ok(MAX_PENDING_MESSAGES >= 100);
  });
});

describe("dropReflected", () => {
  const cutoff = T0; // 10:00:00.000
  const status = (ts) => ({ event: "evt", data: JSON.stringify({ v: 1, ts, src: "hook", type: "feature.status", issue: 1, status: "ready" }) });

  test("un événement antérieur à la limite est écarté", () => {
    assert.equal(dropReflected(status("2026-10-30T09:59:59.999Z"), cutoff), null);
    assert.equal(dropReflected(evt("feature.status", -5, { issue: 1, status: "ready" }), cutoff), null);
  });

  test("un événement à la limite ou postérieur est conservé tel quel (même objet)", () => {
    const equal = status("2026-10-30T10:00:00.000Z");
    const later = status("2026-10-30T10:00:00.001Z");
    assert.equal(dropReflected(equal, cutoff), equal);
    assert.equal(dropReflected(later, cutoff), later);
  });

  test("sans limite connue, rien n'est écarté", () => {
    const old = status("2000-01-01T00:00:00.000Z");
    assert.equal(dropReflected(old, null), old);
    assert.equal(dropReflected(old, undefined), old);
  });

  test("un lot ne garde que les événements récents ; tout écarté -> null ; rien d'écarté -> même message", () => {
    const old = ev("feature.status", -5, { issue: 1, status: "ready" });
    const recent = ev("feature.status", 5, { issue: 2, status: "ready" });
    const mixed = { event: "evt", data: JSON.stringify([old, recent]) };
    const reduced = dropReflected(mixed, cutoff);
    assert.notEqual(reduced, mixed);
    assert.equal(reduced.event, "evt");
    assert.deepEqual(JSON.parse(reduced.data), [recent]);
    assert.equal(dropReflected({ event: "evt", data: JSON.stringify([old, old]) }, cutoff), null);
    const fresh = { event: "evt", data: JSON.stringify([recent]) };
    assert.equal(dropReflected(fresh, cutoff), fresh);
  });

  test("les messages `snapshot` et `warning` ne sont jamais écartés", () => {
    const snapshot = snapshotMsg(stateOf({ updatedAt: at(-60) }));
    assert.equal(dropReflected(snapshot, cutoff), snapshot);
    const warning = { event: "warning", data: JSON.stringify({ code: "C", message: "m", at: at(-60) }) };
    assert.equal(dropReflected(warning, cutoff), warning);
  });

  test("un message illisible ou sans date passe tel quel (apply le signalera)", () => {
    for (const message of [
      { event: "evt", data: "pas du json" },
      { event: "evt", data: JSON.stringify({ type: "feature.status" }) },
      { event: "evt", data: JSON.stringify({ ts: "pas une date" }) },
      { event: "evt", data: JSON.stringify(null) },
      { event: "evt", data: 42 },
      { data: "x" },
      null,
      "texte",
    ]) {
      assert.equal(dropReflected(message, cutoff), message);
    }
  });
});
