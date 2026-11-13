// Disposition 3D de l'ancien pipeline (conservée jusqu'à M6, plus dessinée) : positions des 7 stations sur un axe, des features en file dans
// chaque station et des agents. Module pur : aucun import de `three`, aucun DOM, ni hasard ni horloge. Les positions
// sont de simples objets { x, y, z } (c'est `scene.js` qui les convertit en `Vector3`). ADR 0006 et 0007.
//
// Repère : x est l'axe du pipeline (de Cadrage, à gauche, à Release, à droite), y est la hauteur, z la profondeur
// (z positif vers le spectateur). Chaque boîte est décrite par son centre au sol { x, y: 0, z } et sa taille
// { width (x), height (y), depth (z) }.
//
// Les sorties dépendent uniquement du modèle reçu (`state.js`), sans aucune autre source : le même modèle donne
// toujours les mêmes positions, quel que soit l'ordre des tableaux en entrée.

import { STATIONS, ESCALADE } from "./state.js";
import { MAX_DEV_SEATS, OFFICE, devSeat, seatFor } from "./office-layout.js";

export const LAYOUT = Object.freeze({
  stationWidth: 18,
  stationDepth: 16,
  stationHeight: 6,
  stationGap: 8,
  // Zone d'escalade : une par station (elle est « accolée » à la station indiquée par `feature.station`), derrière
  // elle (z négatif), séparée par `escaladeGap`.
  escaladeDepth: 8,
  escaladeGap: 3,
  padding: 1,
  // Grille des features : pas d'une cellule, hauteur du premier niveau et pas entre deux niveaux (empilement quand
  // la profondeur de la boîte ne suffit plus).
  cell: 1.2,
  floorY: 0.6,
  layerHeight: 1.2,
});

const SPACING = LAYOUT.stationWidth + LAYOUT.stationGap;

// --- Boîtes -----------------------------------------------------------------------------------------------------------

function stationX(index) {
  return (index - (STATIONS.length - 1) / 2) * SPACING;
}

// Boîte d'une station, ou `null` si l'identifiant est inconnu.
export function stationBox(id) {
  const index = STATIONS.indexOf(id);
  if (index === -1) return null;
  return {
    id,
    index,
    x: stationX(index),
    y: 0,
    z: 0,
    width: LAYOUT.stationWidth,
    height: LAYOUT.stationHeight,
    depth: LAYOUT.stationDepth,
  };
}

// Zone d'escalade accolée à une station (z négatif), ou `null` si la station est inconnue.
export function escaladeBox(stationId) {
  const index = STATIONS.indexOf(stationId);
  if (index === -1) return null;
  return {
    id: ESCALADE,
    station: stationId,
    index,
    x: stationX(index),
    y: 0,
    z: -(LAYOUT.stationDepth / 2 + LAYOUT.escaladeGap + LAYOUT.escaladeDepth / 2),
    width: LAYOUT.stationWidth,
    height: LAYOUT.stationHeight,
    depth: LAYOUT.escaladeDepth,
  };
}

// Les 7 stations dans l'ordre du pipeline.
export function stationBoxes() {
  return STATIONS.map(stationBox);
}

// Les 7 zones d'escalade, dans l'ordre des stations.
export function escaladeBoxes() {
  return STATIONS.map(escaladeBox);
}

// Un point est-il dans la boîte ? (bords inclus)
export function boxContains(box, p) {
  return (
    Math.abs(p.x - box.x) <= box.width / 2 &&
    Math.abs(p.z - box.z) <= box.depth / 2 &&
    p.y >= box.y &&
    p.y <= box.y + box.height
  );
}

// --- Features -----------------------------------------------------------------------------------------------------------

// Positions de `count` cellules dans `box`, remplies ligne par ligne. `groups` : effectifs des groupes (un par
// milestone) ; chaque groupe commence sur une nouvelle ligne. Renvoie une liste de { x, y, z, col, row, layer },
// dans l'ordre des groupes puis des éléments.
function gridSlots(groups, box) {
  const { cell, padding, floorY, layerHeight } = LAYOUT;
  const innerW = box.width - 2 * padding;
  const innerD = box.depth - 2 * padding;
  const cols = Math.max(1, Math.floor(innerW / cell));
  const rowsNeeded = groups.reduce((sum, c) => sum + Math.ceil(c / cols), 0);
  const maxLayers = Math.max(1, Math.floor((box.height - floorY) / layerHeight) + 1);
  const rowsPerLayerDefault = Math.max(1, Math.floor(innerD / cell));

  // Cas courant : une couche, pas de 1 cellule. Au-delà, on empile des couches (le pas ne change pas, les positions
  // déjà occupées restent stables) ; si la boîte est vraiment pleine, on resserre les lignes pour tout y faire tenir.
  let rowsPerLayer = rowsPerLayerDefault;
  let rowPitch = cell;
  if (Math.ceil(rowsNeeded / rowsPerLayer) > maxLayers) {
    rowsPerLayer = Math.ceil(rowsNeeded / maxLayers);
    rowPitch = innerD / rowsPerLayer;
  }

  const slots = [];
  let row = 0;
  for (const count of groups) {
    for (let i = 0; i < count; i++) {
      const r = row + Math.floor(i / cols);
      const col = i % cols;
      const layer = Math.floor(r / rowsPerLayer);
      const rowInLayer = r % rowsPerLayer;
      slots.push({
        x: box.x - innerW / 2 + (col + 0.5) * cell,
        y: box.y + floorY + layer * layerHeight,
        z: box.z + innerD / 2 - (rowInLayer + 0.5) * rowPitch,
        col,
        row: r,
        layer,
      });
    }
    row += Math.ceil(count / cols);
  }
  return slots;
}

// Ordre des groupes : les milestones dans l'ordre de leur numéro, puis les features sans milestone connu.
function milestoneRank(model) {
  const rank = new Map();
  [...model.milestones]
    .sort((a, b) => a.number - b.number)
    .forEach((m, i) => rank.set(m.title, i));
  return rank;
}

// Positions de toutes les features. Une feature est rangée dans la file de sa station, ou dans la zone d'escalade
// accolée à sa station si elle est `escalated`. Dans une file : regroupement par milestone, puis tri par numéro.
// Renvoie une Map numéro -> { x, y, z, station, zone: "station" | "escalade", col, row, layer }.
export function layoutFeatures(model) {
  const rank = milestoneRank(model);
  const unknown = rank.size;
  const groupOf = (f) => (f.milestone !== null && rank.has(f.milestone) ? rank.get(f.milestone) : unknown);

  const queues = new Map(); // "zone:station" -> features
  for (const f of model.features) {
    if (!STATIONS.includes(f.station)) continue;
    const key = `${f.escalated ? "escalade" : "station"}:${f.station}`;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(f);
  }

  const out = new Map();
  for (const [key, features] of queues) {
    const [zone, station] = key.split(":");
    features.sort((a, b) => groupOf(a) - groupOf(b) || a.number - b.number);
    const groups = [];
    let previous = null;
    for (const f of features) {
      const g = groupOf(f);
      if (g !== previous) groups.push(0);
      groups[groups.length - 1] += 1;
      previous = g;
    }
    const box = zone === "escalade" ? escaladeBox(station) : stationBox(station);
    const slots = gridSlots(groups, box);
    features.forEach((f, i) => {
      const { x, y, z, col, row, layer } = slots[i];
      out.set(f.number, { x, y, z, station, zone, col, row, layer });
    });
  }
  return out;
}

// --- Agents ---------------------------------------------------------------------------------------------------------------

// Hauteur des sphères d'agents au-dessus du sol : à peu près la tête d'un bonhomme (M6).
export const AGENT_HEIGHT = 1.7;
const WAIT_PITCH = 1;

// Positions des agents, dérivées du plan du bureau (`office-layout.js`) : un agent est placé à la place de sa station
// (`seatFor`, `devSeat`) ; les agents d'une même zone occupent les places dans l'ordre d'arrivée (`since`, puis `id`),
// les développeurs les postes de l'open space. Un agent sans place (station `merge`, `release`, ou inconnue) attend dans
// le couloir, devant la porte. Renvoie une Map id -> { x, y, z, anchor: "seat" | "door", seat: clé de la place | null,
// station }.
export function layoutAgents(model) {
  const agents = [...model.agents].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map();
  const taken = new Map(); // zone -> nombre d'agents déjà placés
  let waiting = 0;

  for (const a of agents) {
    const zone = a.station === null ? "none" : a.station;
    const rank = taken.get(zone) ?? 0;
    taken.set(zone, rank + 1);
    const seat = a.station === "dev" ? devSeat(Math.min(rank, MAX_DEV_SEATS - 1)) : seatFor(a.station, a.type, rank);
    if (seat === null) {
      const { entry } = OFFICE.door;
      out.set(a.id, { x: entry.x + waiting * WAIT_PITCH, y: AGENT_HEIGHT, z: entry.z, anchor: "door", seat: null, station: a.station });
      waiting += 1;
    } else {
      out.set(a.id, { x: seat.x, y: AGENT_HEIGHT, z: seat.z, anchor: "seat", seat: seat.key, station: a.station });
    }
  }
  return out;
}

// --- Scène complète -----------------------------------------------------------------------------------------------------

// Tout ce que l'ancienne scène dessinait pour ce modèle (stations, files, agents). Les agents viennent d'office-layout.js.
export function layoutScene(model) {
  return {
    stations: stationBoxes(),
    escalades: escaladeBoxes(),
    features: layoutFeatures(model),
    agents: layoutAgents(model),
  };
}

