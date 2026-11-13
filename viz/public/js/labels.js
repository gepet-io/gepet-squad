// Étiquettes HTML de la scène (`CSS2DRenderer`) : les noms des zones du bureau et des colonnes du kanban, le compteur
// « +N » d'une colonne pleine, le badge de retry d'un post-it et, au survol d'un post-it, le numéro et le titre de la
// feature. Tout texte est écrit par `textContent` : un titre qui contient du HTML (`<img onerror=…>`) s'affiche tel
// quel, sans être interprété (ADR 0005). Ce module dessine, il ne décide rien : les textes viennent de `view-model.js` et
// `motion.js`, les positions d'`office-layout.js`, la feature sous le pointeur de `scene.pick`.

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

import { OFFICE, kanbanLayout } from "./office-layout.js";
import { retryBadges } from "./motion.js";
import { featureLabel, zoneLabels } from "./view-model.js";

const TOOLTIP_LIFT = 0.45; // au-dessus du post-it survolé
const BADGE_OFFSET = { x: OFFICE.kanban.noteWidth / 2 - 0.1, y: 0, z: 0.2 }; // bord droit du post-it, devant
const COUNTER_OFFSET_Z = 0.2;

function makeLabel(doc, text, className) {
  const element = doc.createElement("div");
  element.className = className;
  element.textContent = text;
  return new CSS2DObject(element);
}

const LABEL_CLASSES = { zone: "label label-zone", column: "label label-station", escalade: "label label-escalade" };

/**
 * Ajoute les étiquettes à la scène.
 * @param {object} sceneApi la valeur renvoyée par `createScene`
 * @param {object} options
 * @param {HTMLElement} options.container élément qui reçoit la couche d'étiquettes
 * @param {Document} [options.document]
 * @param {object} [options.labelRenderer] `CSS2DRenderer` (injectable pour les tests)
 */
export function createLabels(sceneApi, { container, document: doc = globalThis.document, labelRenderer = new CSS2DRenderer() }) {
  const layer = labelRenderer.domElement;
  layer.className = "labels";
  container.appendChild(layer);

  const group = new THREE.Group();
  for (const entry of zoneLabels(OFFICE)) {
    const label = makeLabel(doc, entry.text, LABEL_CLASSES[entry.kind]);
    label.position.set(entry.x, entry.y, entry.z);
    group.add(label);
  }

  // Info-bulle d'une feature : un seul élément, déplacé et réécrit au survol.
  const tooltip = makeLabel(doc, "", "label label-feature");
  tooltip.visible = false;
  group.add(tooltip);

  // Compteurs « +N » (colonne) et badges de retry (post-it).
  const counters = new Map(); // colonne -> CSS2DObject
  const badges = new Map(); // numéro de feature -> CSS2DObject

  function syncCounters(model) {
    const wanted = new Map(kanbanLayout(model).counters.map((counter) => [counter.column, counter]));
    for (const [column, object] of counters) {
      if (wanted.has(column)) continue;
      group.remove(object);
      counters.delete(column);
    }
    for (const [column, counter] of wanted) {
      let object = counters.get(column);
      if (object === undefined) {
        object = makeLabel(doc, "", "label label-counter");
        group.add(object);
        counters.set(column, object);
      }
      const text = `+${counter.extra}`;
      if (object.element.textContent !== text) object.element.textContent = text;
      object.position.set(counter.x, counter.y, counter.z + COUNTER_OFFSET_Z);
    }
  }

  function syncBadges(model) {
    const wanted = new Map(retryBadges(model).map((badge) => [badge.number, badge]));
    for (const [number, object] of badges) {
      if (wanted.has(number)) continue;
      group.remove(object);
      badges.delete(number);
    }
    for (const [number, badge] of wanted) {
      let object = badges.get(number);
      if (object === undefined) {
        object = makeLabel(doc, "", "badge badge-retry");
        object.visible = false; // placé à la prochaine image
        group.add(object);
        badges.set(number, object);
      }
      if (object.element.textContent !== badge.text) object.element.textContent = badge.text;
    }
  }

  const removeLayer = sceneApi.addLayer(group);

  let hovered = null; // numéro de la feature survolée

  function show(feature) {
    hovered = feature.number;
    tooltip.element.textContent = featureLabel(feature);
    tooltip.visible = true;
    place();
  }
  function hide() {
    hovered = null;
    tooltip.visible = false;
  }
  function place() {
    const p = sceneApi.positionOf(hovered);
    if (p === null) return hide();
    tooltip.position.set(p.x, p.y + TOOLTIP_LIFT, p.z);
  }
  function placeBadges() {
    for (const [number, object] of badges) {
      const p = sceneApi.positionOf(number);
      object.visible = p !== null;
      if (p !== null) object.position.set(p.x + BADGE_OFFSET.x, p.y + BADGE_OFFSET.y, p.z + BADGE_OFFSET.z);
    }
  }

  const canvas = sceneApi.domElement;
  const onPointerMove = (event) => {
    const feature = sceneApi.pick(event.clientX, event.clientY);
    if (feature === null) hide();
    else if (feature.number !== hovered || tooltip.element.textContent !== featureLabel(feature)) show(feature);
  };
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", hide);

  const stops = [
    removeLayer,
    sceneApi.onResize((width, height) => labelRenderer.setSize(width, height)),
    // Après une mise à jour : compteurs et badges suivent le modèle, l'info-bulle suit la feature (titre modifié, ou disparue).
    sceneApi.onUpdate((model) => {
      syncCounters(model);
      syncBadges(model);
      if (hovered === null) return;
      const feature = sceneApi.featureByNumber(hovered);
      if (feature === null) hide();
      else show(feature);
    }),
    sceneApi.onFrame(() => {
      if (hovered !== null) place();
      placeBadges();
      labelRenderer.render(sceneApi.scene, sceneApi.camera);
    }),
  ];
  if (sceneApi.model() !== null) {
    syncCounters(sceneApi.model());
    syncBadges(sceneApi.model());
  }
  const { clientWidth, clientHeight } = container;
  if (clientWidth > 0 && clientHeight > 0) labelRenderer.setSize(clientWidth, clientHeight);

  return {
    tooltip,
    group,
    counters,
    badges,
    show,
    hide,
    dispose() {
      for (const stop of stops) stop();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", hide);
      layer.remove?.();
    },
  };
}
