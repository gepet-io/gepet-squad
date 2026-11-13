// Agents lumineux de la scène (provisoires, en attendant les bonhommes de M6), plus le bloom qui les fait briller.
//
// Une entité lumineuse par agent du modèle (`requested`, `running`, `reported`, `unknown`, `finished`) : une sphère en
// HDR dont la couleur dépend du type d'agent. Le bloom (`EffectComposer` + `RenderPass` + `UnrealBloomPass` +
// `OutputPass`, addons vendorisés de Three.js : aucun shader de glow maison) ne retient que ce qui dépasse son seuil,
// donc seulement les agents. Les badges de retry sont passés au kanban (`labels.js`).
//
// Ce module dessine, il ne décide rien (ADR 0006) : couleur, opacité, pulsation, fondu et suivi viennent de
// `motion.js`, positions de `layout.js` (dérivées d'`office-layout.js`), tous purs et testés sous Node.
//
// Branchement : `createAgents(scene)` s'appuie sur les points d'extension de `scene.js` (`addLayer`, `onFrame`,
// `onUpdate`, `onResize`, `setRender`). Propriété : la scène ne libère pas les couches ; `dispose()` d'ici retire la
// couche, les rappels et le rendu, puis libère géométrie, matériaux et compositeur.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { layoutAgents } from "./layout.js";
import {
  BLOOM,
  agentColor,
  agentLook,
  agentVisible,
  fadeStep,
  followPoint,
  glowScale,
  initialOpacity,
  pulseOffset,
  pulseScale,
} from "./motion.js";

const AGENT_RADIUS = 0.45;
const MSAA_SAMPLES = 4;

/**
 * Compositeur de rendu avec bloom : rendu de la scène en HDR (anticrénelé), bloom, puis conversion de sortie.
 * @param {object} sceneApi la valeur renvoyée par `createScene`
 */
export function createBloomComposer(sceneApi) {
  const { renderer, scene, camera } = sceneApi;
  const { width, height } = sceneApi.size();
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: MSAA_SAMPLES });
  const composer = new EffectComposer(renderer, target);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM.strength, BLOOM.radius, BLOOM.threshold));
  composer.addPass(new OutputPass());
  return composer;
}

/**
 * Ajoute les agents lumineux à la scène, chacun dans la zone du bureau de sa station.
 * @param {object} sceneApi la valeur renvoyée par `createScene`
 * @param {object} [options]
 * @param {(sceneApi: object) => object} [options.createComposer] compositeur de rendu (injectable pour les tests) ;
 *   `null` pour ne pas activer le bloom
 * @param {(message: string) => void} [options.warn] journal des avertissements
 */
export function createAgents(
  sceneApi,
  { createComposer = createBloomComposer, warn = (message) => globalThis.console?.warn(message) } = {},
) {
  const group = new THREE.Group();
  const removeLayer = sceneApi.addLayer(group);

  // --- Agents ----------------------------------------------------------------------------------------------------------
  const geometry = new THREE.SphereGeometry(AGENT_RADIUS, 24, 16);
  const entities = new Map(); // id d'agent -> { mesh, material, type, phase, issue, opacity, position, offset }
  let model = null;

  function paint(entity, type) {
    const hex = agentColor(type);
    entity.material.color.setHex(hex).multiplyScalar(glowScale(hex));
    entity.type = type;
  }

  function addEntity(agent) {
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false; // pas dessiné avant sa première position
    group.add(mesh);
    const opacity = initialOpacity(agent.phase, { reduced: sceneApi.reducedMotion() });
    const entity = { mesh, material, type: null, phase: agent.phase, opacity, position: null, offset: pulseOffset(agent.id) };
    paint(entity, agent.type);
    entities.set(agent.id, entity);
    return entity;
  }

  function removeEntity(id) {
    const entity = entities.get(id);
    group.remove(entity.mesh);
    entity.material.dispose();
    entities.delete(id);
  }

  // --- Synchronisation avec le modèle -----------------------------------------------------------------------------------
  function sync(next) {
    model = next;
    const present = new Set(next.agents.map((agent) => agent.id));
    for (const id of [...entities.keys()]) if (!present.has(id)) removeEntity(id);
    for (const agent of next.agents) {
      const entity = entities.get(agent.id) ?? addEntity(agent);
      entity.phase = agent.phase;
      if (entity.type !== agent.type) paint(entity, agent.type);
    }
  }

  // --- Image ---------------------------------------------------------------------------------------------------------------
  function frame(delta, elapsed) {
    if (model === null) return;
    const reduced = sceneApi.reducedMotion();

    // Chaque agent rejoint la place de sa station (office-layout.js, via layout.js).
    const desired = layoutAgents(model);

    for (const [id, entity] of entities) {
      const target = desired.get(id);
      if (target === undefined) continue;
      entity.position = entity.position === null ? { x: target.x, y: target.y, z: target.z } : followPoint(entity.position, target, delta, { reduced });
      entity.mesh.position.set(entity.position.x, entity.position.y, entity.position.z);

      const look = agentLook(entity.phase, { reduced });
      entity.opacity = fadeStep(entity.opacity, look.opacity, delta, { reduced });
      entity.material.opacity = entity.opacity;
      entity.mesh.visible = agentVisible(entity.phase, entity.opacity);
      entity.mesh.scale.setScalar(pulseScale(look.pulse, elapsed, entity.offset));
    }

  }

  // --- Bloom ---------------------------------------------------------------------------------------------------------------
  let composer = null;
  let restoreRender = () => {};
  function stopBloom() {
    restoreRender();
    restoreRender = () => {};
    composer?.dispose?.();
    composer = null;
  }
  if (createComposer !== null) {
    try {
      composer = createComposer(sceneApi);
      restoreRender = sceneApi.setRender((delta) => {
        try {
          composer.render(delta);
        } catch (error) {
          // Le bloom est un plus : si le rendu en HDR échoue, la scène revient au rendu direct, agents compris.
          sceneApi.renderer.setRenderTarget?.(null);
          stopBloom();
          warn(`[gepet-squad-viz] bloom désactivé : ${error.message}`);
          sceneApi.renderer.render(sceneApi.scene, sceneApi.camera);
        }
      });
    } catch (error) {
      composer = null;
      warn(`[gepet-squad-viz] bloom indisponible, agents sans halo : ${error.message}`);
    }
  }

  const stops = [
    removeLayer,
    sceneApi.onUpdate((next) => sync(next)),
    sceneApi.onFrame(frame),
    sceneApi.onResize((width, height) => composer?.setSize(width, height)),
  ];
  if (sceneApi.model() !== null) sync(sceneApi.model()); // couche ajoutée après la première mise à jour

  return {
    group,
    entities,
    get composer() {
      return composer;
    },
    frame,
    dispose() {
      for (const stop of stops) stop();
      stopBloom();
      for (const id of [...entities.keys()]) removeEntity(id);
      geometry.dispose();
    },
  };
}
