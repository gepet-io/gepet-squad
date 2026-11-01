// Étiquettes HTML de la scène (`CSS2DRenderer`) : le nom de chaque station, et, au survol d'une feature, son numéro et
// son titre. Tout texte est écrit par `textContent` : un titre qui contient du HTML (`<img onerror=…>`) s'affiche tel
// quel, sans être interprété (ADR 0005). Ce module dessine, il ne décide rien : les textes viennent de `view-model.js`,
// la feature sous le pointeur de `scene.pick`.

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

import { escaladeBoxes, stationBoxes } from "./layout.js";
import { ESCALADE_NAME, featureLabel, stationName } from "./view-model.js";

const TOOLTIP_LIFT = 1.4; // au-dessus de la feature survolée

function makeLabel(doc, text, className) {
  const element = doc.createElement("div");
  element.className = className;
  element.textContent = text;
  return new CSS2DObject(element);
}

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
  for (const box of stationBoxes()) {
    const label = makeLabel(doc, stationName(box.id), "label label-station");
    label.position.set(box.x, 0, box.z + box.depth / 2 + 1.5);
    group.add(label);
  }
  for (const box of escaladeBoxes()) {
    const label = makeLabel(doc, ESCALADE_NAME, "label label-escalade");
    label.position.set(box.x, 0, box.z + box.depth / 2 - 1);
    group.add(label);
  }

  // Info-bulle d'une feature : un seul élément, déplacé et réécrit au survol.
  const tooltip = makeLabel(doc, "", "label label-feature");
  tooltip.visible = false;
  group.add(tooltip);
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
    // Après une mise à jour : l'info-bulle suit la feature (titre modifié, ou feature disparue).
    sceneApi.onUpdate(() => {
      if (hovered === null) return;
      const feature = sceneApi.featureByNumber(hovered);
      if (feature === null) hide();
      else show(feature);
    }),
    sceneApi.onFrame(() => {
      if (hovered !== null) place();
      labelRenderer.render(sceneApi.scene, sceneApi.camera);
    }),
  ];
  const { clientWidth, clientHeight } = container;
  if (clientWidth > 0 && clientHeight > 0) labelRenderer.setSize(clientWidth, clientHeight);

  return {
    tooltip,
    group,
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
