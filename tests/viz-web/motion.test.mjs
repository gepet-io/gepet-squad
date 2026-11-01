// Tests de viz/public/js/motion.js : courbes et bornes d'interpolation, durées, pistes de déplacement, couleur par type
// d'agent, décision d'opacité par phase, pulsation, fondu, badges de retry. Module pur : aucun DOM, aucun WebGL.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { init } from "../../viz/public/js/state.js";
import { STATUS_COLORS } from "../../viz/public/js/view-model.js";
import {
  AGENT_COLORS,
  AGENT_DEFAULT_COLOR,
  AGENT_LOOKS,
  BLOOM,
  FADE_SECONDS,
  GLOW_LUMINANCE,
  MOVE_MAX_SECONDS,
  MOVE_MIN_SECONDS,
  PULSE_PERIOD_SECONDS,
  SHIFT_SECONDS,
  agentColor,
  agentLook,
  agentVisible,
  easeInOutCubic,
  easeOutCubic,
  fadeStep,
  followPoint,
  glowScale,
  initialOpacity,
  interpolate,
  luminance,
  moveDuration,
  planTracks,
  pulseOffset,
  pulseScale,
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

describe("bloom : seuls les agents brillent", () => {
  test("luminance : noir 0, blanc 1, le vert pèse plus que le bleu", () => {
    assert.equal(luminance(0x000000), 0);
    near(luminance(0xffffff), 1, 1e-6);
    assert.ok(luminance(0x00ff00) > luminance(0xff0000) && luminance(0xff0000) > luminance(0x0000ff));
  });

  test("glowScale ramène chaque couleur d'agent à GLOW_LUMINANCE, quelle que soit sa teinte", () => {
    for (const [type, color] of Object.entries(AGENT_COLORS)) {
      near(luminance(color) * glowScale(color), GLOW_LUMINANCE, 1e-9, type);
    }
    assert.ok(Number.isFinite(glowScale(0x000000)), "pas de division par zéro");
  });

  test("un agent actif dépasse le seuil du bloom, même estompé ; un agent atténué (unknown) ou en fondu ne brille plus", () => {
    for (const phase of ["requested", "running", "reported"]) {
      const shown = GLOW_LUMINANCE * agentLook(phase).opacity;
      assert.ok(shown > BLOOM.threshold, `${phase} : ${shown.toFixed(2)} <= seuil ${BLOOM.threshold}`);
    }
    assert.ok(GLOW_LUMINANCE * agentLook("unknown").opacity < BLOOM.threshold);
    assert.ok(GLOW_LUMINANCE * agentLook("finished").opacity < BLOOM.threshold);
  });

  test("le seuil est au-dessus de la luminance maximale du décor éclairé (sommet d'un cube blanc sous les deux lumières de la scène)", () => {
    // HemisphereLight 1,6 + DirectionalLight 1,8 (cos <= 1) sur l'albédo le plus clair des statuts : borne haute.
    const brightest = Math.max(...Object.values(STATUS_COLORS).map(luminance));
    assert.ok(brightest * (1.6 + 1.8) < BLOOM.threshold, `décor jusqu'à ${(brightest * 3.4).toFixed(2)}`);
  });
});

describe("opacité et pulsation par phase", () => {
  test("running est plein, unknown est atténué, finished est invisible, les autres entre les deux", () => {
    assert.equal(agentLook("running").opacity, 1);
    assert.equal(agentLook("finished").opacity, 0);
    assert.ok(agentLook("unknown").opacity > 0 && agentLook("unknown").opacity < 0.5);
    for (const phase of ["requested", "reported"]) {
      const { opacity } = agentLook(phase);
      assert.ok(opacity > agentLook("unknown").opacity && opacity < 1, phase);
    }
  });

  test("seuls les agents vivants pulsent ; running pulse le plus", () => {
    assert.equal(agentLook("unknown").pulse, 0);
    assert.equal(agentLook("finished").pulse, 0);
    for (const phase of ["requested", "running", "reported"]) assert.ok(agentLook(phase).pulse > 0, phase);
    assert.ok(agentLook("running").pulse > agentLook("requested").pulse);
    assert.ok(agentLook("running").pulse > agentLook("reported").pulse);
  });

  test("une phase inconnue ou absente est traitée comme unknown", () => {
    for (const phase of ["bizarre", undefined, null, "toString"]) assert.deepEqual(agentLook(phase), agentLook("unknown"), String(phase));
  });

  test("prefers-reduced-motion : la pulsation est nulle pour toutes les phases, l'opacité ne change pas", () => {
    for (const phase of Object.keys(AGENT_LOOKS)) {
      const reduced = agentLook(phase, { reduced: true });
      assert.equal(reduced.pulse, 0, phase);
      assert.equal(reduced.opacity, agentLook(phase).opacity, phase);
    }
  });

  test("la table des phases n'est pas modifiable", () => {
    assert.throws(() => {
      "use strict";
      AGENT_LOOKS.running = { opacity: 0, pulse: 0 };
    }, TypeError);
  });

  test("initialOpacity : un agent s'allume en fondu, sauf s'il est déjà terminé ou en mouvement réduit", () => {
    assert.equal(initialOpacity("running"), 0);
    assert.equal(initialOpacity("requested"), 0);
    assert.equal(initialOpacity("finished"), 0);
    assert.equal(initialOpacity("running", { reduced: true }), 1);
    assert.equal(initialOpacity("unknown", { reduced: true }), agentLook("unknown").opacity);
    assert.equal(initialOpacity("finished", { reduced: true }), 0);
  });

  test("agentVisible : seul un agent terminé dont le fondu est achevé disparaît", () => {
    assert.equal(agentVisible("finished", 0), false);
    assert.equal(agentVisible("finished", 0.005), false);
    assert.equal(agentVisible("finished", 0.5), true, "encore en train de s'effacer");
    assert.equal(agentVisible("running", 0), true, "un agent qui s'allume est dessiné dès la première image");
    assert.equal(agentVisible("unknown", 0.3), true);
  });
});

describe("fondu", () => {
  test("fadeStep monte et descend à vitesse constante, sans dépasser la cible", () => {
    near(fadeStep(0, 1, 0.25), 0.25 / FADE_SECONDS);
    near(fadeStep(1, 0, 0.25), 1 - 0.25 / FADE_SECONDS);
    assert.equal(fadeStep(0.9, 1, 5), 1);
    assert.equal(fadeStep(0.1, 0, 5), 0);
    assert.equal(fadeStep(0.4, 0.4, 1), 0.4);
  });

  test("un fondu complet dure FADE_SECONDS : image après image, la cible est atteinte et pas avant", () => {
    let opacity = 1;
    let seconds = 0;
    while (opacity > 0 && seconds < 10) {
      opacity = fadeStep(opacity, 0, 1 / 60);
      seconds += 1 / 60;
    }
    assert.ok(Math.abs(seconds - FADE_SECONDS) < 0.05, `${seconds.toFixed(2)} s`);
  });

  test("sans temps écoulé, rien ne bouge ; avec réduction de mouvement, la cible est atteinte tout de suite", () => {
    assert.equal(fadeStep(0.3, 1, 0), 0.3);
    assert.equal(fadeStep(0.3, 1, -1), 0.3);
    assert.equal(fadeStep(1, 0, 0, { reduced: true }), 0);
    assert.equal(fadeStep(0, 1, 0.001, { reduced: true }), 1);
  });
});

describe("pulsation", () => {
  test("pulseScale oscille entre 1 - a et 1 + a avec la période PULSE_PERIOD_SECONDS", () => {
    const a = 0.2;
    near(pulseScale(a, 0), 1);
    near(pulseScale(a, PULSE_PERIOD_SECONDS / 4), 1.2);
    near(pulseScale(a, (3 * PULSE_PERIOD_SECONDS) / 4), 0.8);
    near(pulseScale(a, 3.3), pulseScale(a, 3.3 + PULSE_PERIOD_SECONDS), 1e-9, "périodique");
    for (let i = 0; i < 200; i++) {
      const s = pulseScale(a, i * 0.037, 1.3);
      assert.ok(s >= 1 - a - 1e-12 && s <= 1 + a + 1e-12);
    }
  });

  test("une amplitude nulle (agent calme, réduction de mouvement) donne toujours 1", () => {
    for (const t of [0, 0.4, 1.7, 99]) assert.equal(pulseScale(0, t, 2), 1);
    assert.equal(pulseScale(-0.5, 0.4), 1);
    assert.equal(pulseScale(agentLook("running", { reduced: true }).pulse, 0.4), 1);
  });

  test("pulseOffset : déterministe, dans [0, 2π[, différent d'un agent à l'autre", () => {
    assert.equal(pulseOffset("a152ecd0174a7c035"), pulseOffset("a152ecd0174a7c035"));
    const offsets = ["a", "b", "agent-1", "agent-2", "a152ecd0174a7c035"].map(pulseOffset);
    for (const o of offsets) assert.ok(o >= 0 && o < 2 * Math.PI);
    assert.ok(new Set(offsets).size >= 4);
  });
});

describe("suivi d'un agent (followPoint)", () => {
  test("se rapproche de la cible sans la dépasser, et l'atteint", () => {
    let p = P(0, 0, 0);
    const target = P(10, 4, -6);
    let previous = Infinity;
    for (let i = 0; i < 600; i++) {
      p = followPoint(p, target, 1 / 60);
      const remaining = Math.hypot(target.x - p.x, target.y - p.y, target.z - p.z);
      assert.ok(remaining <= previous + 1e-12);
      previous = remaining;
    }
    assert.deepEqual(p, target);
  });

  test("avec réduction de mouvement, il est immédiatement sur la cible (copie)", () => {
    const target = P(10, 4, -6);
    const p = followPoint(P(0), target, 1 / 60, { reduced: true });
    assert.deepEqual(p, target);
    assert.notEqual(p, target);
  });

  test("sans temps écoulé, il reste où il est", () => {
    assert.deepEqual(followPoint(P(1, 2, 3), P(10, 10, 10), 0), P(1, 2, 3));
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
