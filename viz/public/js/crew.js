// Machine d'états pure des bonhommes (ADR 0011) : poste, modèle, état, clip, position, bulle et dossier de chaque agent,
// pour le cycle nominal (entrer, travailler, rendre un verdict, repartir). Module pur : aucun import de `three`, aucun DOM,
// ni hasard ni horloge ; le temps est l'argument `now` (ms). Les interruptions, la reprise, le chef de projet et le mode
// réduit complet arrivent avec F-31 (ici, le mode réduit saute seulement la marche).
//
// API : stepCrew(crew, model, transitions, now, reduced) -> crew. `crew` est un tableau de bonhommes (vide au départ) ;
// ni `crew`, ni `model`, ni `transitions` ne sont modifiés. L'état cible vient de la phase de l'agent dans le modèle : les
// transitions de `state.js` ne servent pas à la décider (c'est idempotent, et un pas manqué ne perd rien).
//
// Un bonhomme : { id, role, seat, model, state, clip, position, heading, bubble, folder } plus des champs internes
// (`phase`, `walk`, `since`, `reportedAt`) que `characters.js` ignore.
//   seat    clé du poste dans office-layout.js (`dev:<i>` ou `<station>:<rang>`), fixée à l'entrée
//   state   entering | working | reporting | leaving | gone | stale
//   clip    walk | sit | interact-right | idle | emote-yes | emote-no | holding-both
//   position { x, y, z } (y = 0)   heading : lacet en radians   bubble : texte ou null   folder : { label, x, z } ou null

import { MAX_DEV_SEATS, MAX_ZONE_SEATS, devSeat, seatFor, waypoints } from "./office-layout.js";
import { characterFor } from "./assets.js";
import { durationOf, pathTo, sample } from "./paths.js";

export const BUBBLE_MS = 4000;
export const SIT_MS = 800; // durée du clip `sit` avant de taper

const YES = new Set(["PASS", "LIVRÉ", "APPROUVÉ"]);
const NO = new Set(["FAIL", "BLOQUÉ", "À REVOIR"]);

/** Clip du verdict : `emote-yes`, `emote-no`, ou `holding-both` pour tout autre (ou aucun) verdict. */
export function verdictClip(verdict) {
  const v = typeof verdict === "string" ? verdict.trim().toUpperCase() : "";
  if (YES.has(v)) return "emote-yes";
  if (NO.has(v)) return "emote-no";
  return "holding-both";
}

// --- Places --------------------------------------------------------------------------------------------------------------

const zoneOf = (agent) => (agent.type === "developpeur" ? "dev" : (agent.station ?? (agent.type === "architecte" ? "cadrage" : null)));

// Poste (objet d'office-layout.js, avec `key`) d'une clé de place.
function seatOf(key, role) {
  const [zone, rank] = key.split(":");
  return zone === "dev" ? devSeat(Number(rank)) : seatFor(zone, role, Number(rank));
}

// Première place libre de la zone (`taken` : clés occupées) ; zone pleine : la dernière place. `null` : zone sans place.
function allocate(zone, role, taken) {
  const count = zone === "dev" ? MAX_DEV_SEATS : MAX_ZONE_SEATS;
  if (zone !== "dev" && seatFor(zone, role, 0) === null) return null;
  let rank = 0;
  while (rank < count - 1 && taken.has(`${zone}:${rank}`)) rank++;
  return `${zone}:${rank}`;
}

// --- Marche --------------------------------------------------------------------------------------------------------------

const door = (seat) => waypoints()[seat.key][0];

// Marche de `from` à `to` sur la route du poste, commencée à `at`.
function walkTo(seat, from, to, at) {
  const path = pathTo(from, to, waypoints()[seat.key]);
  return { path, start: at, duration: durationOf(path) };
}

const placeOf = (seat) => ({ x: seat.x, z: seat.z });
const accessOf = (seat) => ({ x: seat.access.x, z: seat.access.z });

// Position courante d'une marche à l'instant `now`.
function walkPosition(walk, now) {
  const t = walk.duration <= 0 ? 1 : (now - walk.start) / walk.duration;
  return sample(walk.path, t);
}

// --- Machine d'états -----------------------------------------------------------------------------------------------------

// Pose `b` au repos à son poste selon la phase `phase`, à l'instant `at`.
function settle(b, seat, phase, at) {
  const rest = { ...b, walk: null, phase, position: { x: seat.x, y: 0, z: seat.z }, heading: seat.rotation, since: at };
  if (phase === "finished") return { ...rest, state: "gone", position: { x: door(seat).x, y: 0, z: door(seat).z } };
  if (phase === "reported") return { ...rest, state: "reporting", reportedAt: at };
  if (phase === "unknown") return { ...rest, state: "stale" };
  return { ...rest, state: "working" };
}

function startEntering(b, seat, from, phase, at, reduced) {
  if (reduced) return settle(b, seat, phase, at);
  return { ...b, phase, state: "entering", since: at, walk: walkTo(seat, from, accessOf(seat), at) };
}

function startLeaving(b, seat, from, phase, at, reduced) {
  if (reduced) return settle(b, seat, "finished", at);
  return { ...b, phase, state: "leaving", since: at, walk: walkTo(seat, from, door(seat), at) };
}

// Fin de marche à `at` (= début + durée).
function arrive(b, seat, at) {
  return b.state === "leaving" ? settle(b, seat, "finished", at) : settle(b, seat, b.phase, at);
}

// Applique le nouveau but `phase` à un bonhomme (marche en cours ou au repos), à l'instant `now`.
function retarget(b, seat, phase, now, reduced) {
  if (reduced) return settle(b, seat, phase, now);
  const finished = phase === "finished";
  if (b.walk) {
    const here = walkPosition(b.walk, now);
    const from = { x: here.x, z: here.z };
    if (b.state === "entering" && finished) return startLeaving(b, seat, from, phase, now, reduced);
    if (b.state === "leaving" && !finished) return startEntering(b, seat, from, phase, now, reduced);
    return { ...b, phase }; // sinon : appliqué à l'arrivée
  }
  if (b.state === "gone") return finished ? { ...b, phase } : startEntering(b, seat, door(seat), phase, now, reduced);
  if (finished) return startLeaving(b, seat, placeOf(seat), phase, now, reduced);
  const state = phase === "reported" ? "reporting" : phase === "unknown" ? "stale" : "working";
  if (state === b.state) return { ...b, phase };
  return { ...b, phase, state, since: now, reportedAt: state === "reporting" ? now : b.reportedAt };
}

// --- Sorties (clip, position, bulle, dossier) ----------------------------------------------------------------------------

function present(b, seat, agent, now) {
  const base = { ...b, folder: null, bubble: null };
  if (b.walk) {
    const p = walkPosition(b.walk, now);
    return { ...base, clip: "walk", position: { x: p.x, y: 0, z: p.z }, heading: p.heading };
  }
  if (b.state === "gone") return { ...base, clip: "idle" };
  const folder = agent.issue == null ? null : { label: `#${agent.issue}`, x: seat.x, z: seat.z };
  const out = { ...base, folder, position: { x: seat.x, y: 0, z: seat.z }, heading: seat.rotation };
  if (b.state === "stale") return { ...out, clip: "idle", bubble: "?" };
  if (b.state === "reporting") {
    if (now - b.reportedAt < BUBBLE_MS) {
      const text = agent.verdict ?? agent.block ?? null;
      return { ...out, clip: verdictClip(agent.verdict), bubble: text };
    }
    return { ...out, clip: seat.seated ? "sit" : "idle" };
  }
  // working : debout, on tape (sauf l'architecte au kanban, qui reste immobile) ; assis, `sit` puis frappe.
  if (!seat.seated) return { ...out, clip: seat.station === "roadmap" && seat.rank === 0 ? "idle" : "interact-right" };
  return { ...out, clip: now - b.since < SIT_MS ? "sit" : "interact-right" };
}

/**
 * Fait avancer l'équipe jusqu'à l'instant `now`.
 * @param {object[]} crew bonhommes précédents (`[]` au départ), non modifiés
 * @param {object} model modèle client de `state.js` (`agents`), non modifié
 * @param {object[]} [transitions] transitions renvoyées par `state.js` (non nécessaires : l'état cible vient du modèle)
 * @param {number} now instant courant en ms
 * @param {boolean} [reduced] `prefers-reduced-motion` : pas de marche
 * @returns {object[]} nouvel état de l'équipe
 */
export function stepCrew(crew, model, transitions, now, reduced = false) {
  void transitions;
  const agents = new Map((model?.agents ?? []).map((a) => [a.id, a]));
  const known = new Map((crew ?? []).filter((b) => agents.has(b.id)).map((b) => [b.id, b]));
  const taken = new Set([...known.values()].map((b) => b.seat));
  const out = [];

  for (const agent of agents.values()) {
    let b = known.get(agent.id);
    let seat;
    if (b) {
      seat = seatOf(b.seat, b.role);
    } else {
      const zone = zoneOf(agent);
      const key = zone === null ? null : allocate(zone, agent.type, taken);
      seat = key === null ? null : seatOf(key, agent.type);
      if (seat === null) continue; // pas de place pour cette station
      taken.add(key);
      const index = Number(key.split(":")[1]);
      b = {
        id: agent.id, role: agent.type, seat: key, model: characterFor(agent.type, index),
        state: "gone", phase: null, walk: null, since: now, reportedAt: null,
        clip: "idle", position: { x: door(seat).x, y: 0, z: door(seat).z }, heading: 0, bubble: null, folder: null,
      };
      b = agent.phase === "finished" ? { ...b, phase: "finished" } : startEntering(b, seat, door(seat), agent.phase, now, reduced);
    }

    // Marches terminées (plusieurs d'affilée possibles : arrivée, puis demi-tour décidé par la phase).
    while (b.walk && now >= b.walk.start + b.walk.duration) {
      const at = b.walk.start + b.walk.duration;
      b = arrive(b, seat, at);
    }
    if (reduced && b.walk) b = settle(b, seat, b.phase, now);
    if (b.phase !== agent.phase) b = retarget(b, seat, agent.phase, now, reduced);
    out.push(present(b, seat, agent, now));
  }
  return out;
}
