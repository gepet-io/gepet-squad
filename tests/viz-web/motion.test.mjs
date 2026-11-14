// Tests de viz/public/js/motion.js : courbes et bornes d'interpolation, durées, pistes de déplacement, couleur par type
// d'agent, badges de retry, absence des exports du pipeline lumineux retiré. Module pur : aucun DOM, aucun WebGL.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { init } from "../../viz/public/js/state.js";
import { STATUS_COLORS } from "../../viz/public/js/view-model.js";
import {
  AGENT_COLORS,
  AGENT_DEFAULT_COLOR,
  MOVE_MAX_SECONDS,
  MOVE_MIN_SECONDS,
  SHIFT_SECONDS,
  agentColor,
  easeInOutCubic,
  easeOutCubic,
  interpolate,
  moveDuration,
  planTracks,
  retryBadgeText,
  retryBadges,
  sampleTracks,
} from "../../viz/public/js/motion.js";
import { feature, stateOf } from "./support.mjs";

const near = (actual, expected, epsilon = 1e-9, message) => assert.ok(Math.abs(actual - expected) <= epsilon, message ?? `${actual} != ${expected}`);
const P = (x, y = 0, z = 0) => ({ x, y, z });

// Écart de couleur CIE76 (ΔE) entre deux couleurs 0xRRGGBB sRGB : ~2 est à peine visible, > 30 se distingue d'un coup d'œil.
function lab(hex) {
  const lin = (shift) => {
    const c = ((hex >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(16), lin(8), lin(0)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

describe("courbes", () => {
  test("easeInOutCubic : bornes, milieu, symétrie, monotonie, départ et arrivée doux", () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(1), 1);
    assert.equal(easeInOutCubic(0.5), 0.5);
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const value = easeInOutCubic(t);
      assert.ok(value >= previous, `non décroissante en t=${t}`);
      near(value + easeInOutCubic(1 - t), 1, 1e-12, `symétrie en t=${t}`);
      previous = value;
    }
    assert.ok(easeInOutCubic(0.1) < 0.1, "démarre lentement");
    assert.ok(easeInOutCubic(0.9) > 0.9, "finit lentement");
  });

  test("easeOutCubic : bornes, monotonie, part vite puis se pose", () => {
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const value = easeOutCubic(i / 100);
      assert.ok(value >= previous);
      previous = value;
    }
    assert.ok(easeOutCubic(0.5) > 0.5);
    near(easeOutCubic(0.5), 0.875);
  });

  test("hors de 0..1, les courbes sont bornées ; une valeur non numérique vaut 0", () => {
    for (const ease of [easeInOutCubic, easeOutCubic]) {
      assert.equal(ease(-3), 0);
      assert.equal(ease(7), 1);
      assert.equal(ease(Infinity), 1);
      assert.equal(ease(NaN), 0);
    }
  });
});

describe("interpolate", () => {
  const from = P(0, 1, -4);
  const to = P(10, 3, 4);

  test("bornes exactes : t <= 0 donne le départ, t >= 1 l'arrivée, sans erreur d'arrondi", () => {
    assert.deepEqual(interpolate(from, to, 0), from);
    assert.deepEqual(interpolate(from, to, -2), from);
    assert.deepEqual(interpolate(from, to, 1), to);
    assert.deepEqual(interpolate(from, to, 1.0001), to);
    assert.deepEqual(interpolate(from, to, NaN), from, "NaN : on reste au départ");
    assert.deepEqual(interpolate(P(0.1, 0.2, 0.3), P(0.7, 0.5, 0.9), 1), P(0.7, 0.5, 0.9));
  });

  test("renvoie un nouveau point : jamais le départ ni l'arrivée eux-mêmes", () => {
    assert.notEqual(interpolate(from, to, 0), from);
    assert.notEqual(interpolate(from, to, 1), to);
  });

  test("milieu de course : la courbe fixe l'avancement sur chaque axe", () => {
    assert.deepEqual(interpolate(from, to, 0.5), P(5, 2, 0), "ease-in-out : le milieu est au milieu");
    const quarter = interpolate(from, to, 0.25, (t) => t);
    assert.deepEqual(quarter, P(2.5, 1.5, -2), "courbe linéaire");
    const out = interpolate(from, to, 0.5, easeOutCubic);
    near(out.x, 8.75);
    near(out.y, 1 + 2 * 0.875);
  });

  test("le trajet est monotone du départ à l'arrivée", () => {
    let previous = -Infinity;
    for (let i = 0; i <= 50; i++) {
      const p = interpolate(from, to, i / 50);
      assert.ok(p.x >= previous);
      assert.ok(p.x >= from.x && p.x <= to.x);
      previous = p.x;
    }
  });
});

describe("moveDuration", () => {
  test("un changement de lieu dure d'autant plus que la distance est grande, entre les bornes", () => {
    const near1 = moveDuration(P(0), P(1));
    const station = moveDuration(P(0), P(26));
    const far = moveDuration(P(0), P(400));
    assert.equal(near1, MOVE_MIN_SECONDS, "minimum pour un petit trajet");
    assert.ok(station > MOVE_MIN_SECONDS && station < MOVE_MAX_SECONDS);
    assert.equal(far, MOVE_MAX_SECONDS, "maximum pour un très long trajet");
    assert.ok(moveDuration(P(0), P(40)) > moveDuration(P(0), P(20)));
    assert.equal(moveDuration(P(0, 0, 0), P(3, 4, 0)), moveDuration(P(0), P(5)), "c'est la distance euclidienne qui compte");
  });

  test("le réarrangement d'une file dure SHIFT_SECONDS, quelle que soit la distance", () => {
    assert.equal(moveDuration(P(0), P(1), "shift"), SHIFT_SECONDS);
    assert.equal(moveDuration(P(0), P(300), "shift"), SHIFT_SECONDS);
    assert.ok(SHIFT_SECONDS < MOVE_MIN_SECONDS);
  });
});

describe("pistes de déplacement (planTracks, sampleTracks)", () => {
  const move = { kind: "feature-move", id: 7, from: "dev", to: "verification" };

  test("une feature-move glisse de sa position affichée à la nouvelle, en 'inOut', sur une durée de déplacement", () => {
    const tracks = planTracks(new Map(), new Map([[7, P(0)]]), new Map([[7, P(26)]]), [move], 12);
    assert.equal(tracks.size, 1);
    const track = tracks.get(7);
    assert.deepEqual(track.from, P(0));
    assert.deepEqual(track.to, P(26));
    assert.equal(track.start, 12);
    assert.equal(track.duration, moveDuration(P(0), P(26), "move"));
    assert.equal(track.ease, "inOut");
  });

  test("sans feature-move, un changement de position est un court glissement ; une feature immobile n'a pas de piste", () => {
    const tracks = planTracks(new Map(), new Map([[1, P(0)], [2, P(5)]]), new Map([[1, P(1.2)], [2, P(5)]]), [], 0);
    assert.deepEqual([...tracks.keys()], [1]);
    assert.equal(tracks.get(1).duration, SHIFT_SECONDS);
    assert.equal(tracks.get(1).ease, "out");
  });

  test("une feature nouvelle apparaît à sa place (pas de piste), une feature disparue n'en garde pas", () => {
    const tracks = planTracks(new Map(), new Map([[1, P(0)]]), new Map([[1, P(0)], [2, P(30)]]), [{ kind: "feature-add", id: 2, from: null, to: "dev" }], 0);
    assert.equal(tracks.size, 0);
    const kept = planTracks(new Map([[1, { from: P(0), to: P(9), start: 0, duration: 1, ease: "inOut" }]]), new Map([[1, P(4)]]), new Map(), [], 0);
    assert.equal(kept.size, 0);
  });

  test("réduction de mouvement : aucune piste, le déplacement est immédiat", () => {
    const targets = new Map([[7, P(26)]]);
    const tracks = planTracks(new Map(), new Map([[7, P(0)]]), targets, [move], 0, { reduced: true });
    assert.equal(tracks.size, 0);
    assert.deepEqual(sampleTracks(tracks, targets, 0).positions.get(7), P(26));
    assert.equal(sampleTracks(tracks, targets, 0).moving, false);
  });

  test("une piste en cours qui mène déjà à la bonne cible est conservée : une mise à jour sans rapport ne la relance pas", () => {
    const targets = new Map([[7, P(26)]]);
    const first = planTracks(new Map(), new Map([[7, P(0)]]), targets, [move], 0);
    const again = planTracks(first, new Map([[7, P(10)]]), targets, [], 0.5);
    assert.equal(again.get(7), first.get(7));
    assert.equal(again.get(7).start, 0);
  });

  test("une cible qui change en route : la nouvelle piste part de la position affichée, pas de l'ancien départ", () => {
    const first = planTracks(new Map(), new Map([[7, P(0)]]), new Map([[7, P(26)]]), [move], 0);
    const mid = sampleTracks(first, new Map([[7, P(26)]]), 0.5).positions;
    const second = planTracks(first, mid, new Map([[7, P(52)]]), [{ ...move, to: "test" }], 0.5);
    assert.deepEqual(second.get(7).from, mid.get(7));
    assert.deepEqual(second.get(7).to, P(52));
    assert.equal(second.get(7).start, 0.5);
  });

  test("sampleTracks : départ exact à t=0, arrivée exacte à la durée, progression entre les deux", () => {
    const targets = new Map([[7, P(26, 0, -10)]]);
    const tracks = planTracks(new Map(), new Map([[7, P(0)]]), targets, [move], 100);
    const { duration } = tracks.get(7);

    const atStart = sampleTracks(tracks, targets, 100);
    assert.deepEqual(atStart.positions.get(7), P(0));
    assert.equal(atStart.moving, true);

    const half = sampleTracks(tracks, targets, 100 + duration / 2);
    const middle = half.positions.get(7);
    near(middle.x, 13, 1e-6, "ease-in-out : à mi-durée, à mi-chemin");
    near(middle.z, -5, 1e-6);
    assert.equal(middle.y, 0);
    assert.equal(half.moving, true);
    assert.equal(half.tracks.size, 1);

    const quarter = sampleTracks(tracks, targets, 100 + duration / 4).positions.get(7);
    assert.ok(quarter.x > 0 && quarter.x < 6.5, "premier quart : moins d'un quart du chemin (départ doux)");

    const end = sampleTracks(tracks, targets, 100 + duration + 1e-6);
    assert.deepEqual(end.positions.get(7), P(26, 0, -10));
    assert.equal(end.moving, false);
    assert.equal(end.tracks.size, 0, "la piste terminée est retirée");

    assert.deepEqual(sampleTracks(tracks, targets, 100 + duration * 5).positions.get(7), P(26, 0, -10));
    assert.deepEqual(sampleTracks(tracks, targets, Infinity).positions.get(7), P(26, 0, -10), "temps infini : arrivée immédiate");
  });

  test("sampleTracks : une feature sans piste est à sa cible, et seules les cibles sont rendues", () => {
    const { positions } = sampleTracks(new Map([[99, { from: P(0), to: P(1), start: 0, duration: 1, ease: "out" }]]), new Map([[1, P(3)]]), 0.2);
    assert.deepEqual([...positions.keys()], [1]);
    assert.deepEqual(positions.get(1), P(3));
  });

  test("les pistes ne modifient pas leurs entrées", () => {
    const currents = Object.freeze(new Map([[7, Object.freeze(P(0))]]));
    const targets = Object.freeze(new Map([[7, Object.freeze(P(26))]]));
    const tracks = planTracks(new Map(), currents, targets, Object.freeze([move]), 0);
    sampleTracks(tracks, targets, 0.3).positions.get(7).x = 999;
    assert.deepEqual(targets.get(7), P(26));
    assert.deepEqual(tracks.get(7).to, P(26));
  });
});

describe("couleur par type d'agent", () => {
  test("une couleur propre à chacun des quatre types ; un type inconnu est neutre", () => {
    assert.equal(agentColor("architecte"), AGENT_COLORS.architecte);
    assert.equal(agentColor("developpeur"), AGENT_COLORS.developpeur);
    assert.equal(agentColor("verificateur"), AGENT_COLORS.verificateur);
    assert.equal(agentColor("testeur"), AGENT_COLORS.testeur);
    assert.deepEqual(Object.keys(AGENT_COLORS).sort(), ["architecte", "developpeur", "testeur", "verificateur"]);
    assert.equal(new Set(Object.values(AGENT_COLORS)).size, 4);
    for (const unknown of ["", "inconnu", undefined, null, "toString", "__proto__", "constructor"]) {
      assert.equal(agentColor(unknown), AGENT_DEFAULT_COLOR, String(unknown));
    }
  });

  test("les couleurs d'agents se distinguent entre elles (ΔE >= 60)", () => {
    const entries = Object.entries(AGENT_COLORS);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        assert.ok(deltaE(entries[i][1], entries[j][1]) >= 60, `${entries[i][0]} / ${entries[j][0]} : ${deltaE(entries[i][1], entries[j][1]).toFixed(0)}`);
      }
    }
  });

  test("les couleurs d'agents se distinguent de chaque couleur de statut (ΔE >= 30)", () => {
    for (const [type, color] of Object.entries(AGENT_COLORS)) {
      for (const [status, statusColor] of Object.entries(STATUS_COLORS)) {
        assert.ok(deltaE(color, statusColor) >= 30, `${type} / ${status} : ${deltaE(color, statusColor).toFixed(0)}`);
      }
    }
  });
});

describe("badges de retry", () => {
  const model = init(
    stateOf({
      features: [
        feature(3, "in-progress", { retry: 2 }),
        feature(1, "in-review", { retry: 1 }),
        feature(2, "ready", { retry: 0 }),
        feature(4, "blocked", { retry: 3 }),
      ],
    }),
  );

  test("une entrée par feature avec retry >= 1, triée par numéro, avec son texte", () => {
    assert.deepEqual(retryBadges(model), [
      { number: 1, retry: 1, text: "Retry 1" },
      { number: 3, retry: 2, text: "Retry 2" },
      { number: 4, retry: 3, text: "Retry 3" },
    ]);
    assert.equal(retryBadgeText(5), "Retry 5");
  });

  test("aucun badge sans retry, et un retry invalide est ignoré", () => {
    assert.deepEqual(retryBadges({ features: [] }), []);
    assert.deepEqual(retryBadges({ features: [{ number: 1, retry: 0 }, { number: 2, retry: null }, { number: 3, retry: -1 }, { number: 4, retry: "2" }, { number: 5 }] }), []);
  });

  test("le texte d'un badge est du texte : un titre piégé n'entre jamais dedans", () => {
    const trapped = init(stateOf({ features: [feature(9, "ready", { retry: 1, title: "<img src=x onerror=alert(1)>" })] }));
    assert.deepEqual(retryBadges(trapped).map((b) => b.text), ["Retry 1"]);
  });
});

describe("retrait du pipeline lumineux (ADR 0009)", () => {
  test("motion.js n'exporte plus le bloom, les sphères lumineuses, leur pulsation ni leur fondu", async () => {
    const exported = Object.keys(await import("../../viz/public/js/motion.js"));
    const removed = [
      "BLOOM", "GLOW_LUMINANCE", "glowScale", "luminance", "AGENT_LOOKS", "agentLook", "PULSE_PERIOD_SECONDS", "pulseOffset",
      "pulseScale", "FADE_SECONDS", "fadeStep", "initialOpacity", "agentVisible", "INVISIBLE", "AGENT_FOLLOW_RATE", "followPoint",
    ];
    for (const name of removed) assert.ok(!exported.includes(name), `${name} est encore exporté`);
    for (const name of ["agentColor", "AGENT_COLORS", "AGENT_DEFAULT_COLOR", "planTracks", "sampleTracks", "retryBadges"]) {
      assert.ok(exported.includes(name), `${name} doit rester exporté`);
    }
  });
});
