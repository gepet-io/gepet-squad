// Éléments de la page hors de la scène : indicateur de connexion, légende des couleurs, avertissement des fichiers 3D
// manquants (le repli texte, sans WebGL, est dans fallback.js). Du DOM, mais pas de `three`. Tout texte venu du serveur
// (titres de features) est affiché par `textContent` : jamais de HTML (ADR 0005, règle ESLint sur innerHTML et outerHTML).

import { assetsWarning, legendEntries } from "./view-model.js";

// Écrit l'état de la connexion dans l'élément `el` : le texte, et `data-state` pour la feuille de style.
export function showConnection(el, status) {
  el.textContent = status.text;
  el.dataset.state = status.state;
}

export function showRepo(el, repo) {
  el.textContent = repo ?? "";
}

// Avertissement unique : « N fichiers 3D n'ont pas pu être chargés ». Sans effet pour `count <= 0` ou sans élément ;
// un second appel réécrit le même élément (jamais deux avertissements).
export function showAssetsWarning(el, count) {
  if (!el || !(count > 0)) return;
  el.textContent = assetsWarning(count);
  el.hidden = false;
}

// Légende : une pastille et le nom de chaque statut.
export function renderLegend(container, doc = globalThis.document) {
  container.textContent = "";
  for (const entry of legendEntries()) {
    const item = doc.createElement("li");
    const swatch = doc.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = entry.css; // CSSOM : autorisé par la CSP (style-src 'self'), contrairement à l'attribut `style`.
    const label = doc.createElement("span");
    label.textContent = entry.label;
    item.append(swatch, label);
    container.append(item);
  }
}
