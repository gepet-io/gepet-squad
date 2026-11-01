// Éléments de la page hors de la scène : indicateur de connexion, légende des couleurs, repli texte quand WebGL n'est
// pas disponible. Du DOM, mais pas de `three`. Tout texte venu du serveur (titres de features) est affiché par
// `textContent` : jamais de HTML (ADR 0005, règle ESLint sur innerHTML et outerHTML).

import { fallbackGroups, legendEntries } from "./view-model.js";

// Écrit l'état de la connexion dans l'élément `el` : le texte, et `data-state` pour la feuille de style.
export function showConnection(el, status) {
  el.textContent = status.text;
  el.dataset.state = status.state;
}

export function showRepo(el, repo) {
  el.textContent = repo ?? "";
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

// Repli texte : les stations et leurs features sous forme de listes.
export function renderFallback(container, model, doc = globalThis.document) {
  container.textContent = "";
  for (const group of fallbackGroups(model)) {
    const section = doc.createElement("section");
    const heading = doc.createElement("h2");
    heading.textContent = group.name;
    section.append(heading);
    const list = doc.createElement("ul");
    for (const feature of group.features) {
      const item = doc.createElement("li");
      item.textContent = `${feature.text} (${feature.status})`;
      list.append(item);
    }
    if (group.features.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "empty";
      empty.textContent = "aucune feature";
      list.append(empty);
    }
    section.append(list);
    container.append(section);
  }
}
