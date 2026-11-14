// Bonhommes du bureau (ADR 0011) : un petit personnage Kenney animé par agent du modèle, plus le chef de projet, avec sa
// bulle de verdict et le dossier posé sur son poste. Remplace les sphères d'`agents.js` (et le bloom qui les faisait briller).
//
// Ce module dessine, il ne décide rien (ADR 0006 et 0011) : poste, modèle, état, clip, position, cap, bulle et dossier
// viennent de `crew.js` (`stepCrew`), le manifeste de `assets.js`, la couleur des capsules de repli de `motion.js`. Ici :
//   - chaque fichier de personnage est chargé une seule fois (`GLTFLoader`, ou le chargeur injecté `loadModel`), puis cloné
//     par `SkeletonUtils.clone` pour chaque bonhomme, qui a son `AnimationMixer` ;
//   - un changement de clip fait un fondu croisé de 0,2 s (`crossFadeTo`) ; quand `crew.js` marque le bonhomme `frozen`
//     (mode réduit), le clip est figé sur sa première image, sans fondu ;
//   - un bonhomme `gone` est retiré de la scène et son mixer est libéré ; il est recréé à sa reprise ;
//   - la bulle de verdict et l'étiquette `#N` du dossier sont des `CSS2DObject` (texte écrit par `textContent`), la
//     feuille de style est `css/characters.css` ;
//   - un modèle qui ne se charge pas est remplacé par une capsule colorée selon le type d'agent, et `onAssetsFailed` est
//     appelé une fois avec le nombre de fichiers en échec (`ui.js` affiche l'avertissement) ;
//   - quand un poste de développeur supplémentaire (`devSeat(i >= 3)`) est occupé, ses meubles sont ajoutés à la scène,
//     puis retirés quand il se libère.
//
// Branchement : `createCharacters(scene)` s'appuie sur les points d'extension de `scene.js` (`addLayer`, `onFrame`,
// `onUpdate`). Propriété : `dispose()` retire la couche et les rappels, libère mixers, capsules et modèles chargés.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

import { ASSETS } from "./assets.js";
import { stepCrew } from "./crew.js";
import { agentColor } from "./motion.js";
import { DEFAULT_DEV_SEATS, devSeat, seatFor } from "./office-layout.js";

export const FADE_SECONDS = 0.2; // fondu croisé entre deux clips
const BUBBLE_LIFT = 1.45; // hauteur de la bulle au-dessus du sol
const FOLDER = { width: 0.34, height: 0.04, depth: 0.25, color: 0xd9b45b, ahead: 0.6, side: 0.5, lift: 0.03 };
const DESK_TOP = 0.75;
const EXTRA_SEAT_FURNITURE = ["desk", "chairDesk", "computerScreen", "computerKeyboard"];

// --- Fonctions pures (testées hors WebGL) --------------------------------------------------------------------------------

/** Couleur de la capsule de repli d'un bonhomme dont le modèle ne s'est pas chargé : celle de son type d'agent. */
export function capsuleColor(role) {
  return agentColor(role);
}

/**
 * Ce que le rendu doit faire du clip décidé par `crew.js`, vu l'action en cours : `keep` (rien), `switch` (fondu croisé de
 * 0,2 s, ou changement sec si figé), `freeze` / `thaw` (même clip, mais le mode réduit vient de changer).
 * @param {string|null} current clip en cours (null au départ)
 * @param {boolean} currentFrozen
 * @param {string} wanted clip demandé
 * @param {boolean} frozen
 */
export function clipAction(current, currentFrozen, wanted, frozen) {
  if (current !== wanted) return "switch";
  if (currentFrozen === frozen) return "keep";
  return frozen ? "freeze" : "thaw";
}

/**
 * Place du dossier : devant le bonhomme (selon son cap), un peu de côté pour laisser le clavier libre ; sur le bureau pour
 * un poste assis, au sol pour une place debout.
 * @param {{ x: number, z: number }} folder
 * @param {number} heading
 * @param {boolean} seated
 */
export function folderPlacement(folder, heading, seated) {
  const forward = { x: Math.sin(heading), z: Math.cos(heading) };
  const right = { x: Math.cos(heading), z: -Math.sin(heading) };
  return {
    x: folder.x + forward.x * FOLDER.ahead + right.x * FOLDER.side,
    y: (seated ? DESK_TOP : 0) + FOLDER.lift,
    z: folder.z + forward.z * FOLDER.ahead + right.z * FOLDER.side,
  };
}

// Poste (office-layout.js) d'une clé de place de `crew.js` (`pm`, `dev:<i>`, `<station>:<rang>`), ou `null`.
function seatOfKey(key, role) {
  if (key === "pm") return { seated: true };
  const [zone, rank] = key.split(":");
  return zone === "dev" ? devSeat(Number(rank)) : seatFor(zone, role, Number(rank));
}

function defaultLoadModel() {
  const loader = new GLTFLoader();
  return (url) => loader.loadAsync(url);
}

// --- Rendu ---------------------------------------------------------------------------------------------------------------

/**
 * Ajoute les bonhommes à la scène.
 * @param {object} sceneApi la valeur renvoyée par `createScene`
 * @param {object} [options]
 * @param {(url: string) => Promise<{ scene: object, animations?: object[] }>} [options.loadModel] chargeur glTF
 *   (un `GLTFLoader` par défaut ; injectable pour les tests)
 * @param {(count: number, ids: string[]) => void} [options.onAssetsFailed] appelé une fois si des fichiers n'ont pas pu
 *   être chargés (personnages ou meubles des postes supplémentaires)
 * @param {Document} [options.document] sert à créer les éléments des bulles et des étiquettes
 */
export function createCharacters(
  sceneApi,
  { loadModel = defaultLoadModel(), onAssetsFailed = () => {}, document: doc = globalThis.document } = {},
) {
  const root = new THREE.Group();
  const removeLayer = sceneApi.addLayer(root);
  let disposed = false;
  let model = null;
  let crew = [];
  let pending = []; // transitions reçues depuis la dernière image : `crew.js` ne doit les voir qu'une fois
  const entries = new Map(); // id -> { group, visual, mixer, actions, action, clip, frozen, bubble, folder, modelPath }

  // --- Chargement : chaque fichier une seule fois ------------------------------------------------------------------------
  const templates = new Map(); // chemin -> { scene, animations, scale } ou null (échec)
  const failed = [];
  const loadOne = async (asset, kind) => {
    try {
      const gltf = await loadModel(asset.path);
      if (!gltf?.scene) throw new Error(`${asset.path} : pas de scène`);
      let object = gltf.scene;
      if (kind === "furniture") {
        // Comme scene.js : l'origine du Furniture Kit est à un coin, on recentre l'emprise sur l'origine, posée au sol.
        const box = new THREE.Box3().setFromObject(object);
        if (!box.isEmpty()) object.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
        object = new THREE.Group().add(object);
      }
      templates.set(asset.path, { scene: object, source: gltf.scene, animations: gltf.animations ?? [], scale: asset.scale });
    } catch {
      templates.set(asset.path, null);
      failed.push(asset.id);
    }
  };
  const furnitureAssets = ASSETS.furniture.filter((asset) => EXTRA_SEAT_FURNITURE.includes(asset.id));
  const ready = Promise.all([
    ...ASSETS.characters.map((asset) => loadOne(asset, "character")),
    ...furnitureAssets.map((asset) => loadOne(asset, "furniture")),
  ]).then(() => {
    if (disposed) return;
    if (failed.length > 0) onAssetsFailed(failed.length, [...failed].sort());
  });
  ready.catch(() => {});
  const loaded = () => templates.size === ASSETS.characters.length + furnitureAssets.length;

  // Capsule de repli : géométrie partagée, un matériau par couleur.
  const capsuleGeometry = new THREE.CapsuleGeometry(0.2, 0.5, 4, 8);
  const capsuleMaterials = new Map();
  const capsuleMaterial = (hex) => {
    if (!capsuleMaterials.has(hex)) capsuleMaterials.set(hex, new THREE.MeshStandardMaterial({ color: hex }));
    return capsuleMaterials.get(hex);
  };

  // --- Un bonhomme ----------------------------------------------------------------------------------------------------------
  function buildVisual(rec, b) {
    const template = templates.get(b.model?.path) ?? null;
    rec.modelPath = b.model?.path ?? null;
    if (template === null) {
      const capsule = new THREE.Mesh(capsuleGeometry, capsuleMaterial(capsuleColor(b.role)));
      capsule.position.y = 0.45;
      rec.visual = capsule;
      rec.mixer = null;
    } else {
      const visual = cloneSkinned(template.scene);
      visual.scale.setScalar(template.scale);
      rec.visual = visual;
      rec.mixer = new THREE.AnimationMixer(visual);
    }
    rec.actions = new Map();
    rec.action = null;
    rec.clip = null;
    rec.frozen = false;
    rec.template = template;
    rec.group.add(rec.visual);
  }

  function dropVisual(rec) {
    if (rec.mixer) {
      rec.mixer.stopAllAction();
      rec.mixer.uncacheRoot(rec.visual);
    }
    rec.group.remove(rec.visual);
    rec.visual = null;
    rec.mixer = null;
    rec.actions = new Map();
    rec.action = null;
    rec.clip = null;
  }

  function actionOf(rec, name) {
    if (rec.mixer === null) return null;
    if (!rec.actions.has(name)) {
      const clip = rec.template.animations.find((c) => c.name === name);
      rec.actions.set(name, clip ? rec.mixer.clipAction(clip) : null);
    }
    return rec.actions.get(name);
  }

  function play(rec, name, frozen) {
    const todo = clipAction(rec.clip, rec.frozen, name, frozen);
    if (todo === "keep") return;
    const next = actionOf(rec, name);
    if (todo === "switch") {
      rec.clip = name;
      rec.frozen = frozen;
      if (next === null) return; // clip absent (ou capsule) : le bonhomme reste dans sa dernière pose
      const previous = rec.action;
      next.reset().setEffectiveWeight(1).play();
      if (frozen) {
        previous?.stop();
        next.paused = true;
        rec.mixer.update(0); // pose de la première image
      } else if (previous && previous !== next) {
        previous.crossFadeTo(next, FADE_SECONDS, false);
      }
      rec.action = next;
      return;
    }
    rec.frozen = frozen;
    if (rec.action === null) return;
    if (todo === "freeze") {
      rec.action.time = 0;
      rec.action.paused = true;
      rec.mixer.update(0);
    } else {
      rec.action.paused = false;
    }
  }

  function textLabel(className, text) {
    const element = doc.createElement("div");
    element.className = className;
    element.textContent = text;
    return new CSS2DObject(element);
  }

  function syncBubble(rec, text) {
    if (text === null) {
      if (rec.bubble) {
        rec.group.remove(rec.bubble); // le retrait de l'objet retire aussi l'élément du DOM
        rec.bubble = null;
      }
      return;
    }
    if (!rec.bubble) {
      rec.bubble = textLabel("bubble-verdict", text);
      rec.bubble.position.set(0, BUBBLE_LIFT, 0);
      rec.group.add(rec.bubble);
    } else if (rec.bubble.element.textContent !== text) {
      rec.bubble.element.textContent = text;
    }
  }

  // Dossier : une boîte posée sur le poste, avec son étiquette `#N`. Il est dans `root`, pas dans le groupe du bonhomme :
  // il ne bouge pas avec lui.
  function syncFolder(rec, b) {
    if (b.folder === null) {
      if (rec.folder) {
        rec.folder.remove(rec.folder.label);
        root.remove(rec.folder);
        rec.folder.box.material.dispose();
        rec.folder.box.geometry.dispose();
        rec.folder = null;
      }
      return;
    }
    if (!rec.folder) {
      const group = new THREE.Group();
      group.box = new THREE.Mesh(
        new THREE.BoxGeometry(FOLDER.width, FOLDER.height, FOLDER.depth),
        new THREE.MeshStandardMaterial({ color: FOLDER.color }),
      );
      group.label = textLabel("label label-folder", b.folder.label);
      group.label.position.set(0, 0.25, 0);
      group.add(group.box, group.label);
      root.add(group);
      rec.folder = group;
    }
    if (rec.folder.label.element.textContent !== b.folder.label) rec.folder.label.element.textContent = b.folder.label;
    const seat = seatOfKey(b.seat, b.role);
    const at = folderPlacement(b.folder, b.heading, seat?.seated === true);
    rec.folder.position.set(at.x, at.y, at.z);
  }

  function removeEntry(id) {
    const rec = entries.get(id);
    syncBubble(rec, null);
    syncFolder(rec, { folder: null });
    if (rec.visual) dropVisual(rec);
    root.remove(rec.group);
    entries.delete(id);
  }

  // --- Meubles des postes supplémentaires ---------------------------------------------------------------------------------
  const extraSeats = new Map(); // indice de poste -> groupe de meubles

  function addExtraSeat(index) {
    const group = new THREE.Group();
    for (const piece of devSeat(index).furniture) {
      const template = templates.get(ASSETS.furniture.find((a) => a.id === piece.id)?.path) ?? null;
      if (template === null) continue;
      const object = template.scene.clone(true);
      object.scale.multiplyScalar(template.scale);
      object.position.set(piece.x, piece.y, piece.z);
      object.rotation.y = piece.rotation;
      group.add(object);
    }
    root.add(group);
    extraSeats.set(index, group);
  }

  function syncExtraSeats(list) {
    const occupied = new Set();
    for (const b of list) {
      const [zone, rank] = b.seat.split(":");
      if (zone === "dev" && Number(rank) >= DEFAULT_DEV_SEATS && b.state !== "gone") occupied.add(Number(rank));
    }
    for (const [index, group] of [...extraSeats]) {
      if (occupied.has(index)) continue;
      root.remove(group);
      extraSeats.delete(index);
    }
    for (const index of occupied) if (!extraSeats.has(index)) addExtraSeat(index);
  }

  // --- Synchronisation avec `crew.js` ---------------------------------------------------------------------------------------
  function sync(list) {
    const present = new Set(list.filter((b) => b.state !== "gone").map((b) => b.id));
    for (const id of [...entries.keys()]) if (!present.has(id)) removeEntry(id);

    for (const b of list) {
      if (b.state === "gone") continue;
      let rec = entries.get(b.id);
      if (!rec) {
        rec = { group: new THREE.Group(), visual: null, mixer: null, actions: new Map(), action: null, clip: null, frozen: false, bubble: null, folder: null, modelPath: null, template: null };
        root.add(rec.group);
        entries.set(b.id, rec);
      }
      if (rec.visual && rec.modelPath !== (b.model?.path ?? null)) dropVisual(rec); // autre modèle (poste réattribué à la reprise)
      if (!rec.visual) buildVisual(rec, b);
      rec.group.position.set(b.position.x, b.position.y, b.position.z);
      rec.group.rotation.y = b.heading;
      play(rec, b.clip, b.frozen === true);
      syncBubble(rec, b.bubble);
      syncFolder(rec, b);
    }
    syncExtraSeats(list);
  }

  // --- Image ----------------------------------------------------------------------------------------------------------------
  // `elapsed` (secondes) fournit l'instant `now` de `crew.js` (ms) : la même horloge à chaque image.
  function frame(delta, elapsed) {
    if (model === null || !loaded()) return; // les modèles ne sont pas tous chargés : pas de bonhomme à moitié construit
    const transitions = pending;
    pending = [];
    crew = stepCrew(crew, model, transitions, elapsed * 1000, sceneApi.reducedMotion());
    sync(crew);
    for (const rec of entries.values()) if (rec.mixer && !rec.frozen) rec.mixer.update(delta);
  }

  const stops = [
    removeLayer,
    sceneApi.onUpdate((next, transitions = []) => {
      model = next;
      pending = pending.concat(transitions);
    }),
    sceneApi.onFrame(frame),
  ];
  if (sceneApi.model() !== null) model = sceneApi.model(); // couche ajoutée après la première mise à jour

  return {
    group: root,
    entries,
    extraSeats,
    ready,
    frame,
    /** Bonhomme affiché pour un agent (`{ group, clip, frozen, bubble, folder, mixer, … }`), ou `undefined`. */
    entry: (id) => entries.get(id),
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
      for (const id of [...entries.keys()]) removeEntry(id);
      for (const group of extraSeats.values()) root.remove(group);
      extraSeats.clear();
      capsuleGeometry.dispose();
      for (const material of capsuleMaterials.values()) material.dispose();
      for (const template of templates.values()) {
        template?.source.traverse((object) => {
          object.geometry?.dispose();
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.dispose();
        });
      }
    },
  };
}
