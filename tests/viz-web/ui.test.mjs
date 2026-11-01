// Tests de viz/public/js/ui.js : indicateur de connexion et légende (le repli texte est testé dans fallback.test.mjs).
// DOM factice dont les éléments refusent toute écriture dans innerHTML ou outerHTML.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderLegend, showConnection, showRepo } from "../../viz/public/js/ui.js";
import { STATUS_COLORS, colorCss } from "../../viz/public/js/view-model.js";
import { fakeDocument, fakeElement } from "./dom-fakes.mjs";

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
