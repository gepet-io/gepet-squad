// Manifeste des assets 3D (ADR 0010) : quel modèle pour quel rôle, à quelle échelle, avec quels clips d'animation
// requis, et le mobilier du bureau. Module pur : aucun import, ni `three`, ni DOM, ni hasard, ni horloge. Les modules de
// décision (`crew.js`) et de rendu (`scene.js`, `characters.js`) lisent ce manifeste ; la liste fait foi.
// Les chemins sont relatifs à `viz/public/` et vivent sous `vendor/kenney/` (voir `vendor/kenney/SOURCE.md`).
// Le manifeste est gelé en profondeur : toute tentative de modification échoue (ou est ignorée hors mode strict).

const VENDOR = "vendor/kenney";

// Clips que chaque personnage doit contenir (vérifié sur les GLB par les tests).
const CLIPS = ["idle", "walk", "sit", "interact-right", "emote-yes", "emote-no", "holding-both"];

// Les mini-personnages font 0,67 de haut pour un bureau (échelle 2) de 0,77 : échelle 2 aussi, soit un bonhomme debout
// d environ 1,7 à 2 fois le plateau (voir tests/viz-web/assets.test.mjs).
export const CHARACTER_SCALE = 2;
// Le clip `sit` abaisse le bassin de 0,15 (unités du modèle) au niveau du sol : à l'échelle du manifeste, un bonhomme assis
// est remonté de ce décalage pour que son bassin repose sur l'assise de la chaise (0,38 à l'échelle du mobilier).
export const SIT_LIFT = 0.33;
const character = (id, role) => ({ id, role, path: `${VENDOR}/characters/${id}.glb`, scale: CHARACTER_SCALE, clips: [...CLIPS] });
// Le Furniture Kit 2.0 est modelé deux fois trop petit pour le bureau (bureau de 0,73 de large pour 1,6 prévu) : échelle 2.
const FURNITURE_SCALE = 2;
const furniture = (id) => ({ id, path: `${VENDOR}/furniture/${id}.glb`, scale: FURNITURE_SCALE });

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const ROLES = Object.freeze(["chef-de-projet", "architecte", "developpeur", "verificateur", "testeur"]);

export const ASSETS = deepFreeze({
  // Texture externe partagée par tous les personnages (les GLB la référencent par chemin relatif).
  texture: { id: "colormap", path: `${VENDOR}/characters/Textures/colormap.png` },
  characters: [
    character("character-female-a", "chef-de-projet"),
    character("character-female-b", "architecte"),
    character("character-male-a", "developpeur"),
    character("character-male-b", "developpeur"),
    character("character-male-c", "developpeur"),
    character("character-female-c", "verificateur"),
    character("character-male-d", "testeur"),
  ],
  furniture: [
    "desk", "chairDesk", "computerScreen", "computerKeyboard", "laptop", "doorway", "wall", "wallWindow",
    "floorFull", "table", "bookcaseOpen", "pottedPlant", "kitchenCoffeeMachine", "trashcan", "lampSquareCeiling",
  ].map(furniture),
});

const DEVELOPERS = ASSETS.characters.filter((c) => c.role === "developpeur");

// Modèle d'un rôle ; pour `developpeur`, le modèle `index % 3` (index entier positif ou nul). Rôle inconnu : null.
export function characterFor(role, index = 0) {
  if (role === "developpeur") {
    const n = Number.isInteger(index) && index >= 0 ? index : 0;
    return DEVELOPERS[n % DEVELOPERS.length];
  }
  return ASSETS.characters.find((c) => c.role === role) ?? null;
}
