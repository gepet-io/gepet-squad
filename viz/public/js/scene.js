// Scène Three.js : les 7 stations et leurs zones d'escalade (positions de layout.js), les features en un seul
// `InstancedMesh` coloré par statut, la caméra `OrbitControls` et la boucle de rendu.
//
// Ce module dessine, il ne décide rien (ADR 0006) : positions, couleurs, correspondance instance -> feature, interpolation
// des déplacements et cadrage viennent de `layout.js`, `motion.js` et `view-model.js`, purs et testés sous Node.
//
// Les déplacements de features sont des interpolations (départ, arrivée, durée, courbe) décidées par `motion.js` : une
// `feature-move` glisse d'une station à l'autre, une file qui se réarrange glisse plus brièvement. Avec
// `prefers-reduced-motion: reduce`, le déplacement est immédiat.
//
// Points d'extension pour les couches suivantes (agents lumineux, effets : agents.js), sans toucher à main.js :
//   scene.onFrame(cb)    cb(delta, elapsed) à chaque image : secondes depuis l'image précédente (au plus 0,1), secondes
//                        depuis le démarrage de la boucle. Renvoie une fonction qui retire le rappel.
//   scene.addLayer(obj)  ajoute un objet Three.js à la scène. Renvoie une fonction qui le retire.
//   scene.onUpdate(cb)   cb(model, transitions) à chaque mise à jour du modèle, pour qui a besoin des données.
//   scene.onResize(cb)   cb(width, height) quand la taille de la vue change.
//   scene.setRender(fn)  remplace le rendu de chaque image (`renderer.render`) par `fn(delta)`, par exemple un
//                        `EffectComposer`. Renvoie une fonction qui rétablit le rendu par défaut.
//   scene.size()         { width, height } courants de la vue.
//   scene.model()        le dernier modèle reçu par `update`, ou `null` (pour une couche ajoutée après la première mise à jour).
//   scene.reducedMotion()  vrai si l'utilisateur demande moins de mouvement (`prefers-reduced-motion: reduce`, relu à
//                        chaque appel).
// `scene.scene`, `scene.camera`, `scene.renderer` et `scene.controls` donnent accès aux objets Three.js.
//
// Propriété des couches. `scene.dispose()` libère ce que la scène a créé elle-même (décor, features, rendu, contrôles) et
// vide ses listes de rappels, mais PAS les objets ajoutés par `addLayer` : leur appelant en reste propriétaire. Il retire
// l'objet avec la fonction renvoyée par `addLayer`, puis libère lui-même géométries, matériaux et textures
// (`dispose()` de chacun). Même règle pour les rappels `onFrame`, `onUpdate` et `onResize` : l'appelant les retire.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { escaladeBoxes, layoutFeatures, stationBoxes } from "./layout.js";
import { planTracks, sampleTracks } from "./motion.js";
import { capacityFor, featureForInstance, featureInstances, fitCamera, sceneBounds, toNdc } from "./view-model.js";

const COLORS = {
  background: 0x161b22,
  floor: 0x2b3442,
  edge: 0x66758c,
  escaladeFloor: 0x4a1f26,
  escaladeEdge: 0xb4535a,
};
const FOV = 45;
const FLOOR_THICKNESS = 0.3;
const FEATURE_SIZE = 0.9;
const MAX_FRAME_DELTA = 0.1;

function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  return renderer;
}

function defaultControls(camera, domElement) {
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49; // jamais sous le sol
  return controls;
}

// Sol, arêtes du volume : une station ou une zone d'escalade.
function createBoxVisual(box, floorColor, edgeColor) {
  const group = new THREE.Group();
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(box.width, FLOOR_THICKNESS, box.depth),
    new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.9, metalness: 0 }),
  );
  floor.position.y = -FLOOR_THICKNESS / 2;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(box.width, box.height, box.depth)),
    new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.45 }),
  );
  edges.position.y = box.height / 2;
  group.add(floor, edges);
  group.position.set(box.x, box.y, box.z);
  return group;
}

/**
 * Crée la scène et démarre la boucle de rendu.
 * @param {object} options
 * @param {HTMLElement} options.container élément qui reçoit le canvas
 * @param {Window} [options.window] fenêtre dont on écoute `resize`
 * @param {object} [options.renderer] moteur de rendu (un `WebGLRenderer` par défaut ; injectable pour les tests)
 * @param {(camera: object, domElement: object) => object} [options.createControls] contrôles de caméra
 * @throws {Error} si WebGL n'est pas disponible (le moteur de rendu par défaut ne peut pas être créé)
 */
export function createScene({
  container,
  window: win = globalThis.window,
  renderer = createRenderer(),
  createControls = defaultControls,
} = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);
  scene.add(new THREE.HemisphereLight(0xdde7ff, 0x1c2230, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-40, 90, 60);
  scene.add(sun);

  // Décor : stations et zones d'escalade, aux positions de layout.js.
  const stations = stationBoxes();
  const escalades = escaladeBoxes();
  const decor = new THREE.Group();
  for (const box of stations) decor.add(createBoxVisual(box, COLORS.floor, COLORS.edge));
  for (const box of escalades) decor.add(createBoxVisual(box, COLORS.escaladeFloor, COLORS.escaladeEdge));
  scene.add(decor);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 4000);
  container.appendChild(renderer.domElement);
  const controls = createControls(camera, renderer.domElement);

  // --- Taille et cadrage initial ---------------------------------------------------------------------------------------
  const sizeOf = () => ({
    width: container.clientWidth || win?.innerWidth || 1,
    height: container.clientHeight || win?.innerHeight || 1,
  });
  const resizeListeners = new Set();
  let viewSize = sizeOf();
  function resize(width, height) {
    const size = width === undefined ? sizeOf() : { width, height };
    viewSize = size;
    renderer.setSize(size.width, size.height);
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
    for (const cb of [...resizeListeners]) cb(size.width, size.height);
  }

  const initial = sizeOf();
  const framing = fitCamera(sceneBounds([...stations, ...escalades]), { fov: FOV, aspect: initial.width / initial.height });
  camera.far = framing.distance * 20;
  camera.position.set(framing.position.x, framing.position.y, framing.position.z);
  controls.target.set(framing.target.x, framing.target.y, framing.target.z);
  controls.maxDistance = framing.distance * 2.5;
  controls.minDistance = 4;
  resize(initial.width, initial.height);
  controls.update();

  const onWindowResize = () => resize();
  win?.addEventListener?.("resize", onWindowResize);

  // --- Features : un seul InstancedMesh ---------------------------------------------------------------------------------
  const featureGeometry = new THREE.BoxGeometry(1, 1, 1);
  const featureMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const tint = new THREE.Color();
  const dummy = new THREE.Object3D();
  let mesh = null;
  let capacity = 0;
  let instances = []; // dans l'ordre des instances
  let targets = new Map(); // numéro -> position cible
  let current = new Map(); // numéro -> position affichée (interpolée)
  let tracks = new Map(); // numéro -> interpolation en cours (motion.js)
  let clock = 0; // secondes de boucle (somme des deltas bornés) : l'horloge des interpolations
  let latestModel = null;
  let dirty = false;
  const reducedQuery = win?.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  const reducedMotion = () => reducedQuery?.matches === true;

  function ensureMesh(count) {
    const wanted = capacityFor(count, capacity);
    if (mesh !== null && wanted === capacity) return;
    if (mesh !== null) {
      scene.remove(mesh);
      mesh.dispose();
    }
    capacity = wanted;
    mesh = new THREE.InstancedMesh(featureGeometry, featureMaterial, capacity);
    mesh.count = 0; // rien n'est dessiné avant le premier writeInstances()
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  function writeInstances() {
    mesh.count = instances.length;
    instances.forEach((instance, index) => {
      const p = current.get(instance.number);
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.setScalar(FEATURE_SIZE);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, tint.setHex(instance.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere(); // le lancer de rayon (pick) s'appuie dessus
  }

  const updateListeners = new Set();
  /** Met la scène à jour avec le modèle de state.js. */
  function update(model, transitions = []) {
    latestModel = model;
    const positions = layoutFeatures(model);
    instances = featureInstances(model, positions);
    targets = new Map(instances.map((instance) => [instance.number, instance.position]));
    ensureMesh(instances.length);
    // Les features nouvelles apparaissent à leur place ; celles dont la cible change glissent depuis leur position affichée.
    tracks = planTracks(tracks, current, targets, transitions, clock, { reduced: reducedMotion() });
    const sampled = sampleTracks(tracks, targets, clock);
    current = sampled.positions;
    tracks = sampled.tracks;
    dirty = true;
    for (const cb of [...updateListeners]) cb(model, transitions);
  }

  // --- Interrogation de la scène ------------------------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  /** La feature affichée sous le point d'écran (clientX, clientY), ou `null`. */
  function pick(clientX, clientY) {
    if (mesh === null || instances.length === 0) return null;
    const ndc = toNdc(clientX, clientY, renderer.domElement.getBoundingClientRect());
    if (ndc === null) return null;
    pointer.set(ndc.x, ndc.y);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(mesh, false)[0];
    return hit ? featureForInstance(instances, hit.instanceId) : null;
  }

  // --- Boucle de rendu -----------------------------------------------------------------------------------------------------
  const frameListeners = new Set();
  let renderFrame = null;
  let last = null;
  function frame(timeMs) {
    const delta = last === null ? 0 : Math.min(Math.max((timeMs - last) / 1000, 0), MAX_FRAME_DELTA);
    last = timeMs;
    clock += delta;
    controls.update?.();
    // Réduction de mouvement activée en cours de route : les déplacements en cours se terminent aussitôt.
    const sampled = sampleTracks(tracks, targets, reducedMotion() ? Infinity : clock);
    current = sampled.positions;
    tracks = sampled.tracks;
    if ((sampled.moving || dirty) && mesh !== null) {
      writeInstances();
      dirty = sampled.moving;
    }
    for (const cb of [...frameListeners]) cb(delta, timeMs / 1000);
    if (renderFrame !== null) renderFrame(delta);
    else renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);

  return {
    scene,
    camera,
    renderer,
    controls,
    domElement: renderer.domElement,
    /** Groupe des 7 stations puis des 7 zones d'escalade (un sous-groupe positionné par boîte de layout.js). */
    decor,
    update,
    pick,
    resize,
    frame,
    /** Position affichée d'une feature (celle de l'image en cours, donc lissée), ou `null`. */
    positionOf: (number) => current.get(number) ?? null,
    /** La feature d'un numéro, telle que dessinée, ou `null`. */
    featureByNumber: (number) => instances.find((instance) => instance.number === number) ?? null,
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    onUpdate(cb) {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    },
    onResize(cb) {
      resizeListeners.add(cb);
      return () => resizeListeners.delete(cb);
    },
    addLayer(object) {
      scene.add(object);
      return () => scene.remove(object);
    },
    setRender(fn) {
      renderFrame = fn;
      return () => {
        if (renderFrame === fn) renderFrame = null;
      };
    },
    size: () => ({ ...viewSize }),
    model: () => latestModel,
    reducedMotion,
    dispose() {
      renderer.setAnimationLoop(null);
      win?.removeEventListener?.("resize", onWindowResize);
      renderFrame = null;
      frameListeners.clear();
      updateListeners.clear();
      resizeListeners.clear();
      controls.dispose?.();
      decor.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      if (mesh !== null) mesh.dispose();
      featureGeometry.dispose();
      featureMaterial.dispose();
      renderer.dispose?.();
      renderer.domElement.remove?.();
    },
  };
}
