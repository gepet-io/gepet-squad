// Disposition 3D du pipeline : positions des 7 stations sur un axe, de la zone d'escalade, des features en file dans
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
  // Agents : hauteur au-dessus de la feature traitée, pas entre deux agents empilés, survol d'une station.
  agentOverFeature: 2,
  agentStack: 1,
  agentHover: 2.5,
  agentPitch: 2,
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

// Positions de répartition de `n` éléments autour de `center`, espacés de `pitch` au plus et sans dépasser `span`.
function spread(center, index, n, span) {
  const pitch = Math.min(LAYOUT.agentPitch, span / Math.max(n, 1));
  return center + (index - (n - 1) / 2) * pitch;
}

// Positions des agents. Un agent qui traite une feature affichée est placé au-dessus d'elle (empilé s'ils sont
// plusieurs) ; sinon au-dessus de sa station (répartis le long de l'axe x) ; un agent d'escalade sans feature
// survole le milieu de la rangée des zones d'escalade ; un agent sans station connue attend avant la première
// station. Renvoie une Map id -> { x, y, z, anchor: "feature" | "station" | "escalade" | "none", feature, station }.
export function layoutAgents(model, featurePositions = layoutFeatures(model)) {
  const agents = [...model.agents].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map();

  const onFeature = new Map(); // numéro -> agents
  const onStation = new Map(); // station | "escalade" | "none" -> agents
  for (const a of agents) {
    if (a.issue !== null && featurePositions.has(a.issue)) {
      if (!onFeature.has(a.issue)) onFeature.set(a.issue, []);
      onFeature.get(a.issue).push(a);
    } else {
      const key = STATIONS.includes(a.station) || a.station === ESCALADE ? a.station : "none";
      if (!onStation.has(key)) onStation.set(key, []);
      onStation.get(key).push(a);
    }
  }

  for (const [issue, list] of onFeature) {
    const p = featurePositions.get(issue);
    list.forEach((a, k) => {
      out.set(a.id, {
        x: p.x,
        y: p.y + LAYOUT.agentOverFeature + k * LAYOUT.agentStack,
        z: p.z,
        anchor: "feature",
        feature: issue,
        station: a.station,
      });
    });
  }

  const innerW = LAYOUT.stationWidth - 2 * LAYOUT.padding;
  for (const [key, list] of onStation) {
    list.forEach((a, k) => {
      let point;
      let anchor;
      if (key === "none") {
        anchor = "none";
        point = { x: stationX(0) - SPACING, y: LAYOUT.agentHover, z: spread(0, k, list.length, LAYOUT.stationDepth) };
      } else if (key === ESCALADE) {
        anchor = "escalade";
        const zone = escaladeBox(STATIONS[0]);
        point = { x: spread(0, k, list.length, innerW), y: zone.height + LAYOUT.agentHover, z: zone.z };
      } else {
        anchor = "station";
        const box = stationBox(key);
        point = { x: spread(box.x, k, list.length, innerW), y: box.height + LAYOUT.agentHover, z: box.z };
      }
      out.set(a.id, { ...point, anchor, feature: null, station: a.station });
    });
  }
  return out;
}

// --- Scène complète -----------------------------------------------------------------------------------------------------

// Tout ce que `scene.js` doit dessiner pour ce modèle.
export function layoutScene(model) {
  const features = layoutFeatures(model);
  return {
    stations: stationBoxes(),
    escalades: escaladeBoxes(),
    features,
    agents: layoutAgents(model, features),
  };
}
