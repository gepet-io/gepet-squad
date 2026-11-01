// Tests de viz/public/js/ui.js : indicateur de connexion, légende, repli texte. DOM factice dont les éléments refusent
// toute écriture dans innerHTML ou outerHTML.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { init } from "../../viz/public/js/state.js";
import { renderFallback, renderLegend, showConnection, showRepo } from "../../viz/public/js/ui.js";
import { STATUS_COLORS, colorCss } from "../../viz/public/js/view-model.js";
import { fakeDocument, fakeElement } from "./dom-fakes.mjs";
import { feature, stateOf } from "./support.mjs";

// Texte de tous les descendants, élément par élément.
function flatten(element, out = []) {
  out.push(element);
  for (const child of element.children) flatten(child, out);
  return out;
}

describe("indicateur de connexion", () => {
  test("showConnection écrit le texte et l'état (pour la feuille de style)", () => {
    const el = fakeElement("span");
    el.dataset = {};
    showConnection(el, { state: "reconnecting", text: "reconnexion…" });
    assert.equal(el.textContent, "reconnexion…");
    assert.equal(el.dataset.state, "reconnecting");
    showConnection(el, { state: "open", text: "connecté" });
    assert.equal(el.textContent, "connecté");
    assert.equal(el.dataset.state, "open");
  });

  test("showRepo écrit le nom du dépôt, ou rien", () => {
    const el = fakeElement("span");
    showRepo(el, "o/r");
    assert.equal(el.textContent, "o/r");
    showRepo(el, null);
    assert.equal(el.textContent, "");
  });
});

describe("légende", () => {
  test("une entrée par statut, avec la pastille de sa couleur (par CSSOM, pas d'attribut style)", () => {
    const doc = fakeDocument();
    const list = fakeElement("ul");
    renderLegend(list, doc);
    assert.equal(list.children.length, Object.keys(STATUS_COLORS).length);
    const first = list.children[0];
    const [swatch, label] = first.children;
    assert.equal(swatch.className, "swatch");
    assert.equal(swatch.style.backgroundColor, colorCss(STATUS_COLORS.backlog));
    assert.equal(swatch.attributes.style, undefined, "pas d'attribut style : interdit par la CSP");
    assert.equal(label.textContent, "Backlog");
  });

  test("appelée deux fois, la légende est remplacée, pas dupliquée", () => {
    const doc = fakeDocument();
    const list = fakeElement("ul");
    renderLegend(list, doc);
    renderLegend(list, doc);
    assert.equal(list.children.length, Object.keys(STATUS_COLORS).length);
  });
});

describe("repli texte", () => {
  const html = '<img src=x onerror="alert(1)">';
  const model = init(
    stateOf({
      features: [feature(1, "ready", { title: "Première" }), feature(2, "in-progress", { title: html }), feature(3, "blocked", { title: "Bloquée" })],
    }),
  );

  test("une section par station (plus l'escalade), avec ses features en texte brut", () => {
    const doc = fakeDocument();
    const container = fakeElement("section");
    renderFallback(container, model, doc);
    assert.equal(container.children.length, 8);
    const headings = container.children.map((section) => section.children[0].textContent);
    assert.deepEqual(headings, ["Cadrage", "Roadmap", "Développement", "Vérification", "Test", "Merge", "Release", "Escalade"]);
    const texts = flatten(container).map((el) => el.textContent);
    assert.ok(texts.includes("#1 Première (Prête)"));
    assert.ok(texts.includes(`#2 ${html} (En cours)`), "le titre HTML est affiché tel quel");
    assert.ok(texts.includes("#3 Bloquée (Bloquée (escalade))"));
    assert.ok(texts.includes("aucune feature"), "une station vide l'indique");
  });

  test("aucun nœud n'est créé à partir du titre : seul textContent est écrit (innerHTML lèverait une erreur)", () => {
    const doc = fakeDocument();
    const container = fakeElement("section");
    renderFallback(container, model, doc);
    const titled = flatten(container).find((el) => el.textContent.includes(html));
    assert.deepEqual(titled.children, []);
    assert.equal(titled.tagName, "LI");
  });

  test("un nouvel appel remplace le contenu précédent", () => {
    const doc = fakeDocument();
    const container = fakeElement("section");
    renderFallback(container, model, doc);
    renderFallback(container, init(stateOf({ features: [feature(9, "done")] })), doc);
    assert.equal(container.children.length, 7);
    assert.ok(flatten(container).some((el) => el.textContent === "#9 Feature 9 (Terminée)"));
  });
});
