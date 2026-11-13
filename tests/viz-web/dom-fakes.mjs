// Faux éléments DOM et faux moteur de rendu pour tester scene.js et labels.js sous Node (pas de navigateur, pas de WebGL).
// Ce fichier n'est pas un test (il ne porte pas le suffixe `.test.mjs`).

export function fakeElement(tagName = "div", extra = {}) {
  const listeners = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    style: {},
    className: "",
    children: [],
    attributes: {},
    listeners,
    clientWidth: 0,
    clientHeight: 0,
    removed: false,
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, ...event });
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    append(...children) {
      element.children.push(...children);
    },
    remove() {
      element.removed = true;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: element.clientWidth || 800, height: element.clientHeight || 600 }),
    ...extra,
  };
  // Comme dans un vrai DOM, écrire textContent remplace tous les enfants par un simple texte.
  let text = "";
  Object.defineProperty(element, "textContent", {
    get: () => text,
    set(value) {
      text = String(value);
      element.children = [];
    },
    enumerable: true,
  });
  // Le HTML ne doit jamais être interprété : toute écriture dans innerHTML ou outerHTML fait échouer le test.
  for (const name of ["innerHTML", "outerHTML"]) {
    Object.defineProperty(element, name, {
      get() {
        throw new Error(`lecture de ${name}`);
      },
      set() {
        throw new Error(`écriture dans ${name} : le HTML ne doit jamais être interprété`);
      },
    });
  }
  return element;
}

export function fakeDocument() {
  return { createElement: (tag) => fakeElement(tag) };
}

/** Moteur de rendu factice : enregistre les tailles, les rendus et la fonction de boucle. */
export function fakeRenderer({ width = 800, height = 600 } = {}) {
  const domElement = fakeElement("canvas", {
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  });
  const renderer = {
    domElement,
    sizes: [],
    renders: 0,
    loop: undefined,
    disposed: false,
    setSize(w, h) {
      renderer.sizes.push([w, h]);
    },
    getPixelRatio: () => 1,
    setRenderTarget() {},
    render() {
      renderer.renders += 1;
    },
    setAnimationLoop(fn) {
      renderer.loop = fn;
    },
    dispose() {
      renderer.disposed = true;
    },
  };
  return renderer;
}

/**
 * Fenêtre factice : `addEventListener("resize", …)`, `innerWidth` et `innerHeight`. `window.media.reduced` pilote
 * `matchMedia("(prefers-reduced-motion: reduce)")`, relu à chaque lecture de `.matches` comme dans un navigateur.
 */
export function fakeWindow(width = 800, height = 600) {
  const media = { reduced: false, queries: [] };
  return fakeElement("window", {
    innerWidth: width,
    innerHeight: height,
    media,
    matchMedia(query) {
      media.queries.push(query);
      return { media: query, get matches() { return query.includes("prefers-reduced-motion: reduce") && media.reduced; } };
    },
  });
}

/** Conteneur factice d'une taille donnée. */
export function fakeContainer(width = 800, height = 600) {
  return fakeElement("div", { clientWidth: width, clientHeight: height });
}

/**
 * Page factice de viz/public/index.html : `getElementById` renvoie les éléments dont main.js (`boot`) a besoin.
 * `elements.repli.hidden` vaut `true` au départ, comme dans la page. `getContext` : celui des canvas créés (la sonde WebGL
 * de `webglAvailable`) ; par défaut, un contexte factice (WebGL disponible).
 */
export function fakePage({ getContext = () => ({}) } = {}) {
  const elements = {};
  for (const [id, tag] of [["connexion", "span"], ["depot", "span"], ["scene", "main"], ["legende", "ul"], ["avertissement", "p"], ["repli", "section"]]) {
    elements[id] = fakeElement(tag, { id, hidden: id === "repli", dataset: {} });
  }
  return {
    elements,
    createElement: (tag) => (tag === "canvas" ? fakeElement(tag, { getContext }) : fakeElement(tag)),
    getElementById: (id) => elements[id] ?? null,
  };
}

/**
 * Faux chargeur glTF pour `createScene({ loadModel })` : chaque appel enregistre l'URL dans `log` et rend une scène d'un
 * maillage ; une URL qui contient l'une des chaînes de `fail` est rejetée. `THREE` : le module `three`, importé par le test.
 */
export function fakeLoader(THREE, { fail = [], log = [] } = {}) {
  const loader = async (url) => {
    log.push(url);
    if (fail.some((part) => url.includes(part))) throw new Error(`chargement impossible : ${url}`);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    return { scene: root };
  };
  loader.log = log;
  return loader;
}

/** Un faux élément et tous ses descendants, dans l'ordre du document. */
export function flatten(element, out = []) {
  out.push(element);
  for (const child of element.children) flatten(child, out);
  return out;
}
