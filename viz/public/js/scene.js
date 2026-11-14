// Scène Three.js du bureau (ADR 0009 et 0010) : murs et sol, mobilier glTF aux positions d'`office-layout.js`, kanban
// mural dont les post-its (les features) forment un seul `InstancedMesh` coloré par statut, la caméra `OrbitControls` et
// la boucle de rendu.
//
// Ce module dessine, il ne décide rien (ADR 0006) : positions, couleurs, correspondance instance -> feature, interpolation
// des déplacements et cadrage viennent de `office-layout.js`, `motion.js` et `view-model.js`, purs et testés sous Node.
//
// Mobilier. Chaque fichier de `assets.js` est chargé une seule fois (`GLTFLoader`, ou le chargeur injecté `loadModel`),
// puis cloné pour chaque meuble placé. Un fichier qui ne se charge pas est omis : la scène s'affiche quand même, et
// `onAssetsFailed(nombre, identifiants)` est appelé une seule fois avec le nombre de fichiers en échec (`ui.js` l'affiche).
// `scene.furnitureReady` se résout quand tous les chargements sont terminés (jamais rejetée).
//
// Les déplacements de post-its sont des interpolations (départ, arrivée, durée, courbe) décidées par `motion.js` : une
// `feature-move` glisse d'une colonne à l'autre, une colonne qui se réarrange glisse plus brièvement. Avec
// `prefers-reduced-motion: reduce`, le déplacement est immédiat.
//
// Points d'extension pour les couches suivantes (bonhommes : characters.js ; étiquettes : labels.js), sans toucher à main.js :
//   scene.onFrame(cb)    cb(delta, elapsed) à chaque image : secondes depuis l'image précédente (au plus 0,1), secondes
//                        depuis le démarrage de la boucle. Renvoie une fonction qui retire le rappel.
//   scene.addLayer(obj)  ajoute un objet Three.js à la scène. Renvoie une fonction qui le retire.
//   scene.onUpdate(cb)   cb(model, transitions) à chaque mise à jour du modèle, pour qui a besoin des données.
//   scene.onResize(cb)   cb(width, height) quand la taille de la vue change.
//   scene.size()         { width, height } courants de la vue.
//   scene.model()        le dernier modèle reçu par `update`, ou `null` (pour une couche ajoutée après la première mise à jour).
//   scene.reducedMotion()  vrai si l'utilisateur demande moins de mouvement (`prefers-reduced-motion: reduce`, relu à
//                        chaque appel).
// `scene.scene`, `scene.camera`, `scene.renderer` et `scene.controls` donnent accès aux objets Three.js.
//
// Propriété des couches. `scene.dispose()` libère ce que la scène a créé elle-même (décor, mobilier, post-its, rendu,
// contrôles) et vide ses listes de rappels, mais PAS les objets ajoutés par `addLayer` : leur appelant en reste propriétaire. Il retire
// l'objet avec la fonction renvoyée par `addLayer`, puis libère lui-même géométries, matériaux et textures
// (`dispose()` de chacun). Même règle pour les rappels `onFrame`, `onUpdate` et `onResize` : l'appelant les retire.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { ASSETS } from "./assets.js";
import { KANBAN_MAX_PER_COLUMN, OFFICE, kanbanLayout } from "./office-layout.js";
import { planTracks, sampleTracks } from "./motion.js";
import { capacityFor, featureForInstance, featureInstances, fitCamera, kanbanPositions, sceneBounds, toNdc } from "./view-model.js";

const COLORS = {
  background: 0x161b22,
  floor: 0x3a4556,
  wall: 0x56627a,
  board: 0x1d232d,
  column: 0x2a3242,
  columnEscalade: 0x5a1f26,
};
const FOV = 45;
// Marge de cadrage : les coins du sol, côté spectateur, sont plus proches de la caméra que le centre et paraissent plus larges.
const FRAMING_MARGIN = 1.45;
const FLOOR_THICKNESS = 0.2;
const WALL_THICKNESS = 0.2;
const DOOR_WIDTH = 1.4;
// Post-it : hauteur un peu sous le pas des lignes, épaisseur qui dépasse du panneau ; la largeur est `OFFICE.kanban.noteWidth`.
const NOTE_HEIGHT = 0.42;
const NOTE_DEPTH = 0.12;
const BOARD_MARGIN = 0.35;
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

function defaultLoadModel() {
  const loader = new GLTFLoader();
  return (url) => loader.loadAsync(url);
}

function slab(width, height, depth, color, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 }));
  mesh.position.set(x, y, z);
  return mesh;
}

// Murs (fond, gauche avec l'ouverture de la porte, droite), sol, zones teintées et panneau du kanban. Le mur d'entrée
// côté spectateur est omis : la caméra regarde dans le bureau comme dans une maison de poupée.
function createDecor() {
  const { walls, door, kanban } = OFFICE;
  const width = walls.maxX - walls.minX;
  const depth = walls.maxZ - walls.minZ;
  const half = walls.height / 2;
  const group = new THREE.Group();
  group.add(slab(width, FLOOR_THICKNESS, depth, COLORS.floor, 0, -FLOOR_THICKNESS / 2, 0));
  group.add(slab(width + 2 * WALL_THICKNESS, walls.height, WALL_THICKNESS, COLORS.wall, 0, half, walls.minZ - WALL_THICKNESS / 2));
  group.add(slab(WALL_THICKNESS, walls.height, depth, COLORS.wall, walls.maxX + WALL_THICKNESS / 2, half, 0));
  const leftX = walls.minX - WALL_THICKNESS / 2;
  const gapStart = door.z - DOOR_WIDTH / 2;
  const gapEnd = door.z + DOOR_WIDTH / 2;
  group.add(slab(WALL_THICKNESS, walls.height, gapStart - walls.minZ, COLORS.wall, leftX, half, (walls.minZ + gapStart) / 2));
  group.add(slab(WALL_THICKNESS, walls.height, walls.maxZ - gapEnd, COLORS.wall, leftX, half, (gapEnd + walls.maxZ) / 2));

  // Zones teintées (la salle d'escalade est éclairée en rouge).
  for (const zone of Object.values(OFFICE.zones)) {
    if (!zone.tint) continue;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(zone.width, zone.depth),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(zone.tint), transparent: true, opacity: 0.18, depthWrite: false }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(zone.x, 0.02, zone.z);
    group.add(plane);
  }

  // Kanban : un panneau, une bande par colonne (rouge pour l'escalade).
  const first = kanban.columns[0].x;
  const last = kanban.columns[kanban.columns.length - 1].x;
  const bottom = kanban.top - KANBAN_MAX_PER_COLUMN * kanban.rowStep - BOARD_MARGIN;
  const top = kanban.top + BOARD_MARGIN;
  const boardWidth = last - first + kanban.columnWidth;
  group.add(slab(boardWidth + 0.3, top - bottom + 0.3, 0.1, COLORS.board, (first + last) / 2, (top + bottom) / 2, kanban.z - 0.05));
  for (const column of kanban.columns) {
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(kanban.columnWidth - 0.2, top - bottom),
      new THREE.MeshStandardMaterial({ color: column.id === "escalade" ? COLORS.columnEscalade : COLORS.column, roughness: 1 }),
    );
    strip.position.set(column.x, (top + bottom) / 2, kanban.z + 0.005);
    group.add(strip);
  }
  return group;
}

// Charge chaque fichier de mobilier une fois, puis place un clone par meuble de `OFFICE.furniture`. Ne rejette jamais :
// un fichier en échec est omis et compté.
function loadFurniture(group, loadModel, { isDisposed, onAssetsFailed, onLoaded }) {
  const assets = new Map(ASSETS.furniture.map((asset) => [asset.id, asset]));
  const ids = [...new Set(OFFICE.furniture.map((piece) => piece.id))];
  const failed = [];
  const templates = new Map();

  const loadOne = async (id) => {
    try {
      const asset = assets.get(id);
      if (asset === undefined) throw new Error(`meuble inconnu du manifeste : ${id}`);
      const gltf = await loadModel(asset.path);
      if (!gltf?.scene) throw new Error(`${asset.path} : pas de scène`);
      // Le Furniture Kit place l'origine d'un meuble à un coin : on recentre l'emprise sur l'origine, posée au sol, pour que
      // la position d'`OFFICE.furniture` soit le centre du meuble.
      const box = new THREE.Box3().setFromObject(gltf.scene);
      if (!box.isEmpty()) gltf.scene.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      const pivot = new THREE.Group();
      pivot.add(gltf.scene);
      templates.set(id, { object: pivot, scale: asset.scale });
      onLoaded(gltf.scene);
    } catch {
      failed.push(id);
    }
  };

  return Promise.all(ids.map(loadOne)).then(() => {
    if (isDisposed()) return;
    for (const piece of OFFICE.furniture) {
      const template = templates.get(piece.id);
      if (template === undefined) continue;
      const object = template.object.clone(true);
      object.scale.multiplyScalar(template.scale);
      object.position.set(piece.x, piece.y, piece.z);
      object.rotation.y = piece.rotation;
      group.add(object);
    }
    if (failed.length > 0) onAssetsFailed(failed.length, [...failed].sort());
  });
}

/**
 * Crée la scène et démarre la boucle de rendu.
 * @param {object} options
 * @param {HTMLElement} options.container élément qui reçoit le canvas
 * @param {Window} [options.window] fenêtre dont on écoute `resize`
 * @param {object} [options.renderer] moteur de rendu (un `WebGLRenderer` par défaut ; injectable pour les tests)
 * @param {(camera: object, domElement: object) => object} [options.createControls] contrôles de caméra
 * @param {(url: string) => Promise<{ scene: object }>} [options.loadModel] chargeur de modèles glTF (un `GLTFLoader`
 *   par défaut ; injectable pour les tests)
 * @param {(count: number, ids: string[]) => void} [options.onAssetsFailed] appelé une fois si des fichiers de mobilier
 *   n'ont pas pu être chargés
 * @throws {Error} si WebGL n'est pas disponible (le moteur de rendu par défaut ne peut pas être créé), ou si la
 *   construction échoue plus loin (contrôles de caméra, par exemple) : le moteur de rendu et le canvas déjà créés sont
 *   alors libérés avant que l'erreur ne remonte, puisque l'appelant n'a pas la scène pour le faire.
 */
export function createScene({
  container,
  window: win = globalThis.window,
  renderer = createRenderer(),
  createControls = defaultControls,
  loadModel = defaultLoadModel(),
  onAssetsFailed = () => {},
} = {}) {
  try {
    return buildScene({ container, win, renderer, createControls, loadModel, onAssetsFailed });
  } catch (error) {
    renderer.setAnimationLoop?.(null);
    renderer.dispose?.();
    renderer.domElement?.remove?.();
    throw error;
  }
}

function buildScene({ container, win, renderer, createControls, loadModel, onAssetsFailed }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);
  scene.add(new THREE.HemisphereLight(0xdde7ff, 0x1c2230, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-40, 90, 60);
  scene.add(sun);

  // Décor (murs, sol, kanban) et mobilier glTF, aux positions d'office-layout.js.
  const decor = createDecor();
  scene.add(decor);
  const furniture = new THREE.Group();
  scene.add(furniture);
  const loadedTemplates = [];
  let disposed = false;
  const furnitureReady = loadFurniture(furniture, loadModel, {
    isDisposed: () => disposed,
    onAssetsFailed,
    onLoaded: (object) => loadedTemplates.push(object),
  }).catch(() => {});

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
  const { walls } = OFFICE;
  const footprint = {
    x: (walls.minX + walls.maxX) / 2,
    y: 0,
    z: (walls.minZ + walls.maxZ) / 2,
    width: walls.maxX - walls.minX,
    depth: walls.maxZ - walls.minZ,
    height: walls.height,
  };
  const framing = fitCamera(sceneBounds([footprint]), { fov: FOV, aspect: initial.width / initial.height, margin: FRAMING_MARGIN });
  camera.far = framing.distance * 20;
  camera.position.set(framing.position.x, framing.position.y, framing.position.z);
  controls.target.set(framing.target.x, framing.target.y, framing.target.z);
  controls.maxDistance = framing.distance * 2.5;
  controls.minDistance = 4;
  resize(initial.width, initial.height);
  controls.update();

  const onWindowResize = () => resize();

  // --- Post-its : un seul InstancedMesh ----------------------------------------------------------------------------------
  const noteGeometry = new THREE.BoxGeometry(1, 1, 1);
  const noteMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
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
    mesh = new THREE.InstancedMesh(noteGeometry, noteMaterial, capacity);
    mesh.count = 0; // rien n'est dessiné avant le premier writeInstances()
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  function writeInstances() {
    mesh.count = instances.length;
    instances.forEach((instance, index) => {
      const p = current.get(instance.number);
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.set(OFFICE.kanban.noteWidth, NOTE_HEIGHT, NOTE_DEPTH);
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
    const positions = kanbanPositions(kanbanLayout(model));
    instances = featureInstances(model, positions);
    targets = new Map(instances.map((instance) => [instance.number, instance.position]));
    ensureMesh(instances.length);
    // Les post-its nouveaux apparaissent à leur place ; ceux dont la cible change glissent depuis leur position affichée.
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
    renderer.render(scene, camera);
  }
  // En dernier : une construction qui échoue plus haut n'a encore rien branché sur la fenêtre.
  win?.addEventListener?.("resize", onWindowResize);
  renderer.setAnimationLoop(frame);

  return {
    scene,
    camera,
    renderer,
    controls,
    domElement: renderer.domElement,
    /** Groupe des murs, du sol, des zones teintées et du panneau du kanban. */
    decor,
    /** Groupe du mobilier : un objet par meuble d'`OFFICE.furniture` dont le fichier a pu être chargé. */
    furniture,
    /** Promesse résolue quand tous les fichiers de mobilier sont chargés (ou ont échoué) et le mobilier posé. */
    furnitureReady,
    update,
    pick,
    resize,
    frame,
    /** Le maillage des post-its (`InstancedMesh`), ou `null` avant la première mise à jour. */
    notes: () => mesh,
    /** Position affichée d'un post-it (celle de l'image en cours, donc lissée), ou `null`. */
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
    size: () => ({ ...viewSize }),
    model: () => latestModel,
    reducedMotion,
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      win?.removeEventListener?.("resize", onWindowResize);
      frameListeners.clear();
      updateListeners.clear();
      resizeListeners.clear();
      controls.dispose?.();
      decor.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      // Les clones partagent géométries et matériaux de leur modèle d'origine : on libère les originaux.
      for (const template of loadedTemplates) {
        template.traverse((object) => {
          object.geometry?.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material?.dispose();
        });
      }
      scene.remove(decor, furniture);
      if (mesh !== null) mesh.dispose();
      noteGeometry.dispose();
      noteMaterial.dispose();
      renderer.dispose?.();
      renderer.domElement.remove?.();
    },
  };
}
