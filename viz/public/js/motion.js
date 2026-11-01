// Tout ce que l'animation décide, sous forme de fonctions pures : courbes et durées des déplacements de features,
// couleur et opacité des agents lumineux, pulsation, badges de retry, réglages du bloom. Module pur : aucun import de
// `three`, aucun DOM, ni hasard ni horloge (le temps est toujours un argument, en secondes). `scene.js` et `agents.js`
// (qui importent `three`) ne font que dessiner ce que ce module calcule (ADR 0006, 0007). Pas de bibliothèque de tween :
// une interpolation est une donnée (départ, arrivée, début, durée, courbe) que l'on échantillonne à chaque image.
//
// Réduction de mouvement : toutes les fonctions qui animent prennent `reduced` ; vrai, elles donnent directement
// l'état final (déplacement immédiat, fondu immédiat) et la pulsation est nulle.
//
// Les positions sont de simples objets { x, y, z } (c'est `scene.js` qui les convertit en `Vector3`).

import { approach } from "./view-model.js";

// --- Courbes ---------------------------------------------------------------------------------------------------------

export const clamp01 = (t) => (Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : t > 0 ? 1 : 0);

// Accélère puis ralentit (déplacement d'une station à l'autre).
export function easeInOutCubic(t) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

// Part vite puis se pose (réarrangement d'une file).
export function easeOutCubic(t) {
  return 1 - (1 - clamp01(t)) ** 3;
}

export const EASINGS = Object.freeze({ inOut: easeInOutCubic, out: easeOutCubic });

// --- Déplacement des features --------------------------------------------------------------------------------------

export const MOVE_MIN_SECONDS = 0.7;
export const MOVE_MAX_SECONDS = 1.8;
export const MOVE_BASE_SECONDS = 0.5;
export const MOVE_UNITS_PER_SECOND = 40;
export const SHIFT_SECONDS = 0.45;

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const samePoint = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const copyPoint = (p) => ({ x: p.x, y: p.y, z: p.z });

// Point entre `from` et `to` à l'instant normalisé `t` (0..1), selon la courbe `ease`. Les bornes sont exactes :
// t <= 0 donne `from`, t >= 1 donne `to`, quelle que soit la courbe.
export function interpolate(from, to, t, ease = easeInOutCubic) {
  if (!(t > 0)) return copyPoint(from);
  if (t >= 1) return copyPoint(to);
  const k = ease(t);
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k };
}

// Durée (secondes) d'un déplacement : proportionnelle à la distance, bornée. `kind` : "move" (changement de lieu) ou
// "shift" (la file se réarrange : durée fixe, courte).
export function moveDuration(from, to, kind = "move") {
  if (kind === "shift") return SHIFT_SECONDS;
  return Math.min(Math.max(MOVE_BASE_SECONDS + distance(from, to) / MOVE_UNITS_PER_SECOND, MOVE_MIN_SECONDS), MOVE_MAX_SECONDS);
}

// Les interpolations à lancer pour une mise à jour du modèle.
//   previous    interpolations en cours (Map numéro -> piste) : une piste qui mène déjà à la bonne cible est conservée,
//               pour qu'une mise à jour sans rapport ne relance pas un déplacement en route
//   currents    positions affichées (Map numéro -> point) : le départ d'une piste est toujours la position affichée,
//               donc un déplacement interrompu repart de là où la feature se trouve
//   targets     positions d'arrivée (Map numéro -> point)
//   transitions celles de `state.js` : une `feature-move` donne un déplacement de station, tout autre changement de
//               position (la file se réarrange) un court glissement
//   now         instant (secondes) du lancement
// Une feature absente de `currents` (nouvelle) apparaît à sa place ; avec `reduced`, aucune piste : tout est immédiat.
// Renvoie une Map numéro -> { from, to, start, duration, ease } (ease : nom dans EASINGS).
export function planTracks(previous, currents, targets, transitions, now, { reduced = false } = {}) {
  const tracks = new Map();
  if (reduced) return tracks;
  const moved = new Set(transitions.filter((t) => t.kind === "feature-move").map((t) => t.id));
  for (const [number, target] of targets) {
    const from = currents.get(number);
    if (from === undefined || samePoint(from, target)) continue;
    const old = previous.get(number);
    if (old !== undefined && samePoint(old.to, target)) {
      tracks.set(number, old);
      continue;
    }
    const kind = moved.has(number) ? "move" : "shift";
    tracks.set(number, {
      from: copyPoint(from),
      to: copyPoint(target),
      start: now,
      duration: moveDuration(from, target, kind),
      ease: kind === "move" ? "inOut" : "out",
    });
  }
  return tracks;
}

// Positions affichées à l'instant `now` : { positions: Map numéro -> point, tracks: pistes encore en cours, moving }.
// Une feature sans piste est à sa cible ; une piste terminée (ou `now` infini) donne exactement la cible.
export function sampleTracks(tracks, targets, now) {
  const positions = new Map();
  const running = new Map();
  for (const [number, target] of targets) {
    const track = tracks.get(number);
    const t = track === undefined ? 1 : (now - track.start) / track.duration;
    if (track === undefined || !(t < 1)) {
      positions.set(number, copyPoint(target));
      continue;
    }
    positions.set(number, interpolate(track.from, target, t, EASINGS[track.ease] ?? easeInOutCubic));
    running.set(number, track);
  }
  return { positions, tracks: running, moving: running.size > 0 };
}

// --- Agents : couleur, opacité, pulsation ----------------------------------------------------------------------------

// Couleur d'émission par type d'agent. Volontairement hors de la palette des statuts (view-model.js) : magenta, cyan,
// citron vert et orange vif, d'écart de couleur (ΔE) mesuré avec chaque statut par tests/viz-web/motion.test.mjs.
export const AGENT_COLORS = Object.freeze({
  architecte: 0xff4fd8,
  developpeur: 0x35e0ff,
  verificateur: 0xb6ff4d,
  testeur: 0xff9a3c,
});
export const AGENT_DEFAULT_COLOR = 0xa0a8b5;

export function agentColor(type) {
  return Object.prototype.hasOwnProperty.call(AGENT_COLORS, type) ? AGENT_COLORS[type] : AGENT_DEFAULT_COLOR;
}

// Luminance relative (0..1) d'une couleur 0xRRGGBB sRGB.
export function luminance(hex) {
  const channel = (shift) => {
    const c = ((hex >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

// Le bloom ne retient que ce qui dépasse `threshold` : une entité lumineuse est rendue en HDR, avec un facteur qui
// ramène sa luminance à GLOW_LUMINANCE quelle que soit sa teinte. Le décor éclairé reste sous le seuil.
export const BLOOM = Object.freeze({ strength: 0.9, radius: 0.55, threshold: 2.4 });
export const GLOW_LUMINANCE = 4;

export function glowScale(hex, target = GLOW_LUMINANCE) {
  return target / Math.max(luminance(hex), 0.05);
}

// Aspect d'un agent selon sa phase : opacité visée et amplitude de la pulsation (part du rayon).
//   requested : demandé, pas encore démarré (estompé, hésitant)   running : au travail
//   reported  : a rendu son rapport (se calme)                    finished : disparaît en fondu
//   unknown   : plus de signal depuis longtemps (atténué, sans pulsation)
export const AGENT_LOOKS = Object.freeze({
  requested: { opacity: 0.65, pulse: 0.1 },
  running: { opacity: 1, pulse: 0.18 },
  reported: { opacity: 0.9, pulse: 0.06 },
  finished: { opacity: 0, pulse: 0 },
  unknown: { opacity: 0.3, pulse: 0 },
});

// { opacity, pulse } d'une phase ; une phase inconnue est traitée comme `unknown`. Sans mouvement : pas de pulsation.
export function agentLook(phase, { reduced = false } = {}) {
  const look = Object.prototype.hasOwnProperty.call(AGENT_LOOKS, phase) ? AGENT_LOOKS[phase] : AGENT_LOOKS.unknown;
  return { opacity: look.opacity, pulse: reduced ? 0 : look.pulse };
}

export const PULSE_PERIOD_SECONDS = 1.6;
export const FADE_SECONDS = 1;
export const AGENT_FOLLOW_RATE = 5;
export const INVISIBLE = 0.01;

// Décalage de phase (radians) propre à un agent, pour que plusieurs agents ne battent pas à l'unisson.
export function pulseOffset(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) % 100003;
  return (hash / 100003) * 2 * Math.PI;
}

// Facteur d'échelle d'un agent à l'instant `elapsed` (secondes) : 1 ± amplitude, jamais négatif.
export function pulseScale(amplitude, elapsed, offset = 0) {
  if (!(amplitude > 0)) return 1;
  return 1 + amplitude * Math.sin((2 * Math.PI * elapsed) / PULSE_PERIOD_SECONDS + offset);
}

// Opacité après `dt` secondes : va vers `target` à vitesse constante (un fondu complet dure FADE_SECONDS), sans le
// dépasser. Avec `reduced`, elle y est tout de suite.
export function fadeStep(current, target, dt, { reduced = false } = {}) {
  if (reduced || !(dt > 0)) return reduced ? target : current;
  const step = dt / FADE_SECONDS;
  return current < target ? Math.min(current + step, target) : Math.max(current - step, target);
}

// Opacité d'un agent à son apparition : il s'allume en fondu (0), sauf s'il est déjà à sa valeur finale (terminé) ou si
// l'utilisateur demande moins de mouvement.
export function initialOpacity(phase, { reduced = false } = {}) {
  const target = agentLook(phase).opacity;
  return reduced || target === 0 ? target : 0;
}

// Un agent terminé dont le fondu est achevé n'est plus dessiné.
export function agentVisible(phase, opacity) {
  return !(phase === "finished" && opacity <= INVISIBLE);
}

// Position d'un agent qui suit sa cible (la feature qu'il traite, qui se déplace elle-même) : rapprochement
// exponentiel indépendant de la cadence ; immédiat avec `reduced`.
export function followPoint(current, target, dt, { reduced = false, rate = AGENT_FOLLOW_RATE } = {}) {
  if (reduced) return copyPoint(target);
  return { x: approach(current.x, target.x, dt, rate), y: approach(current.y, target.y, dt, rate), z: approach(current.z, target.z, dt, rate) };
}

// --- Badges de retry -------------------------------------------------------------------------------------------------

// Texte du badge d'une feature qui a été renvoyée en correctif `retry` fois (affiché par `textContent`).
export const retryBadgeText = (retry) => `Retry ${retry}`;

// Les badges à afficher : une entrée par feature avec retry >= 1, par numéro. [{ number, retry, text }]
export function retryBadges(model) {
  return [...model.features]
    .filter((f) => Number.isInteger(f.retry) && f.retry >= 1)
    .sort((a, b) => a.number - b.number)
    .map((f) => ({ number: f.number, retry: f.retry, text: retryBadgeText(f.retry) }));
}
