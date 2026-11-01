// Tests de viz/public/js/fallback.js : la transformation état -> structure de liste (module pur, importé sans DOM),
// `?mode=texte`, et l'écriture du DOM par createElement / textContent. Les faux éléments refusent toute écriture dans
// innerHTML ou outerHTML.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { apply, init } from "../../viz/public/js/state.js";
import {
  TEXT_MODE,
  UNPLACED,
  fallbackView,
  forcesFallback,
  renderFallback,
  retryBadge,
  webglAvailable,
} from "../../viz/public/js/fallback.js";
import { STATUS_COLORS, colorCss } from "../../viz/public/js/view-model.js";
import { PUBLIC_DIR } from "./importmap.mjs";
import { fakeDocument, fakeElement, flatten } from "./dom-fakes.mjs";
import { agent, deepFreeze, evt, feature, stateOf, at } from "./support.mjs";

const modelOf = (features = [], agents = [], extra = {}) => init(stateOf({ features, agents, ...extra }));
const ids = (view) => view.groups.map((g) => g.id);
const group = (view, id) => view.groups.find((g) => g.id === id);

describe("?mode=texte", () => {
  test("force la vue de repli", () => {
    assert.equal(TEXT_MODE, "texte");
    assert.equal(forcesFallback("?mode=texte"), true);
    assert.equal(forcesFallback("mode=texte"), true);
    assert.equal(forcesFallback("?x=1&mode=texte"), true);
    assert.equal(forcesFallback("?mode=TEXTE"), true);
  });

  test("ne force rien sans ce paramètre ou avec une autre valeur", () => {
    for (const search of ["", "?", "?mode=3d", "?mode=", "?mode=textes", "?mode", "?xmode=texte", "?texte", null, undefined, 42]) {
      assert.equal(forcesFallback(search), false, String(search));
    }
  });
});

describe("webglAvailable : sonde du contexte WebGL", () => {
  const docWith = (getContext) => ({ createElement: (tag) => (tag === "canvas" ? { getContext } : fakeElement(tag)) });

  test("vrai quand un contexte WebGL 2 ou WebGL 1 peut être créé, et le contexte est aussitôt libéré", () => {
    const lost = [];
    const gl = { getExtension: (name) => (name === "WEBGL_lose_context" ? { loseContext: () => lost.push(name) } : null) };
    assert.equal(webglAvailable(docWith((type) => (type === "webgl2" ? gl : null))), true);
    assert.deepEqual(lost, ["WEBGL_lose_context"]);
    assert.equal(webglAvailable(docWith((type) => (type === "webgl" ? gl : null))), true, "WebGL 1 suffit");
    assert.equal(webglAvailable(docWith(() => ({}))), true, "un contexte sans extension de libération");
  });

  test("faux quand aucun contexte ne peut être créé, ou quand la création lève", () => {
    assert.equal(webglAvailable(docWith(() => null)), false);
    const refuses = () => {
      throw new Error("contexte refusé");
    };
    assert.equal(webglAvailable(docWith(refuses)), false);
    assert.equal(webglAvailable({ createElement: () => ({}) }), false, "canvas sans getContext");
    assert.equal(webglAvailable({}), false, "document inutilisable");
  });
});

describe("fallbackView : stations", () => {
  test("les 7 stations sont toujours listées, dans l'ordre du pipeline, même sans feature", () => {
    const view = fallbackView(modelOf());
    assert.deepEqual(ids(view), ["cadrage", "roadmap", "dev", "verification", "test", "merge", "release"]);
    assert.deepEqual(view.groups.map((g) => g.name), ["Cadrage", "Roadmap", "Développement", "Vérification", "Test", "Merge", "Release"]);
    for (const g of view.groups) {
      assert.deepEqual(g.features, []);
      assert.deepEqual(g.agents, []);
    }
    assert.equal(view.featureCount, 0);
    assert.equal(view.agentCount, 0);
  });

  test("chaque feature est dans la station de son statut", () => {
    const view = fallbackView(
      modelOf([
        feature(1, "backlog"),
        feature(2, "ready"),
        feature(3, "in-progress"),
        feature(4, "changes-requested"),
        feature(5, "in-review"),
        feature(6, "in-test"),
        feature(7, "done"),
      ]),
    );
    const numbers = (id) => group(view, id).features.map((f) => f.number);
    assert.deepEqual(numbers("roadmap"), [1, 2]);
    assert.deepEqual(numbers("dev"), [3, 4]);
    assert.deepEqual(numbers("verification"), [5]);
    assert.deepEqual(numbers("test"), [6]);
    assert.deepEqual(numbers("merge"), [7]);
    assert.equal(view.featureCount, 7);
  });

  test("une feature bloquée est dans l'escalade, pas dans sa station ; la zone n'existe que si elle sert", () => {
    const calm = fallbackView(modelOf([feature(1, "ready")]));
    assert.equal(ids(calm).includes("escalade"), false);
    assert.equal(ids(calm).includes(UNPLACED), false);

    const view = fallbackView(modelOf([feature(1, "in-progress"), feature(2, "blocked")]));
    assert.deepEqual(ids(view), ["cadrage", "roadmap", "dev", "verification", "test", "merge", "release", "escalade"]);
    assert.equal(group(view, "escalade").name, "Escalade");
    assert.deepEqual(group(view, "escalade").features.map((f) => f.number), [2]);
    assert.deepEqual(group(view, "dev").features.map((f) => f.number), [1]);
    assert.equal(group(view, "escalade").features[0].statusLabel, "Bloquée (escalade)");
  });

  test("une feature au statut inconnu n'est pas perdue : elle va dans « Sans station »", () => {
    // Cas défensif : `init` écarte les statuts inconnus, mais la vue ne doit jamais faire disparaître une feature.
    const model = modelOf([feature(1, "ready")]);
    model.features.push({ number: 2, title: null, milestone: null, status: "mystere", retry: 0, pr: null, station: null, escalated: false });
    const view = fallbackView(model);
    assert.equal(ids(view).at(-1), UNPLACED);
    const row = group(view, UNPLACED).features[0];
    assert.equal(row.number, 2);
    assert.equal(row.statusLabel, "mystere");
    assert.equal(row.status, "unknown");
  });
});

describe("fallbackView : features", () => {
  test("triées par numéro dans leur station, quel que soit l'ordre du modèle", () => {
    const model = modelOf([feature(30, "ready"), feature(4, "ready"), feature(12, "backlog")]);
    model.features.reverse();
    assert.deepEqual(group(fallbackView(model), "roadmap").features.map((f) => f.number), [4, 12, 30]);
  });

  test("le texte est « #n titre », ou « #n » sans titre", () => {
    const view = fallbackView(modelOf([feature(5, "ready", { title: "Afficher le repli" }), feature(6, "ready", { title: null })]));
    assert.deepEqual(group(view, "roadmap").features.map((f) => f.text), ["#5 Afficher le repli", "#6"]);
  });

  test("badge retry : présent à partir d'une tentative, absent sinon", () => {
    const view = fallbackView(
      modelOf([feature(1, "in-progress", { retry: 0 }), feature(2, "in-progress", { retry: 1 }), feature(3, "in-review", { retry: 3 })]),
    );
    const byNumber = Object.fromEntries(view.groups.flatMap((g) => g.features).map((f) => [f.number, f]));
    assert.equal(byNumber[1].retryBadge, null);
    assert.equal(byNumber[1].retry, 0);
    assert.equal(byNumber[2].retryBadge, "retry 1");
    assert.equal(byNumber[3].retryBadge, "retry 3");
    assert.equal(byNumber[3].retry, 3);
    assert.equal(retryBadge(0), null);
    assert.equal(retryBadge(-1), null);
    assert.equal(retryBadge(1.5), null);
    assert.equal(retryBadge(undefined), null);
    assert.equal(retryBadge(2), "retry 2");
  });

  test("le statut est donné en toutes lettres, avec sa clé pour la feuille de style", () => {
    const view = fallbackView(modelOf([feature(1, "in-progress"), feature(2, "done"), feature(3, "in-test")]));
    const rows = Object.fromEntries(view.groups.flatMap((g) => g.features).map((f) => [f.number, f]));
    assert.deepEqual([rows[1].statusLabel, rows[1].status], ["En cours", "in-progress"]);
    assert.deepEqual([rows[2].statusLabel, rows[2].status], ["Terminée", "done"]);
    assert.deepEqual([rows[3].statusLabel, rows[3].status], ["En test", "in-test"]);
  });
});

describe("fallbackView : agents actifs", () => {
  test("un agent actif est listé dans la station de son type, avec type, mode et issue", () => {
    const view = fallbackView(
      modelOf(
        [feature(13, "in-progress")],
        [
          agent("a1", { type: "claude-gepet-squad:developpeur", mode: "IMPLEMENTATION", issue: 13, station: undefined, phase: "running" }),
          agent("a2", { type: "verificateur", mode: null, issue: 12, station: undefined, phase: "requested" }),
          agent("a3", { type: "testeur", mode: "TEST", issue: 11, station: undefined, phase: "reported" }),
        ],
      ),
    );
    assert.deepEqual(group(view, "dev").agents.map((a) => a.text), ["developpeur · IMPLEMENTATION · #13"]);
    assert.deepEqual(group(view, "verification").agents.map((a) => a.text), ["verificateur · #12"]);
    assert.deepEqual(group(view, "test").agents.map((a) => a.text), ["testeur · TEST · #11"]);
    const dev = group(view, "dev").agents[0];
    assert.deepEqual([dev.type, dev.mode, dev.issue, dev.phase, dev.phaseLabel], ["developpeur", "IMPLEMENTATION", 13, "running", "en cours"]);
    assert.deepEqual(group(view, "verification").agents[0].phaseLabel, "demandé");
    assert.deepEqual(group(view, "test").agents[0].phaseLabel, "rapport rendu");
    assert.equal(view.agentCount, 3);
  });

  test("les agents terminés ou silencieux ne sont pas listés", () => {
    const view = fallbackView(
      modelOf([], [
        agent("a1", { issue: 1, phase: "finished", finishedAt: at(1) }),
        agent("a2", { issue: 2, phase: "unknown" }),
        agent("a3", { issue: 3, phase: "running" }),
      ]),
    );
    assert.deepEqual(group(view, "dev").agents.map((a) => a.issue), [3]);
    assert.equal(view.agentCount, 1);
  });

  test("l'architecte est dans la station de son mode, un agent sans station dans « Sans station »", () => {
    const view = fallbackView(
      modelOf([], [
        agent("a1", { type: "architecte", mode: "CADRAGE_QUESTIONS", station: undefined }),
        agent("a2", { type: "architecte", mode: "REVUE_ROADMAP", station: undefined }),
        agent("a3", { type: "architecte", mode: "ESCALADE", issue: 9, station: undefined }),
        agent("a4", { type: "inconnu", mode: null, station: undefined }),
      ]),
    );
    assert.deepEqual(group(view, "cadrage").agents.map((a) => a.text), ["architecte · CADRAGE_QUESTIONS"]);
    assert.deepEqual(group(view, "roadmap").agents.map((a) => a.text), ["architecte · REVUE_ROADMAP"]);
    assert.deepEqual(group(view, "escalade").agents.map((a) => a.text), ["architecte · ESCALADE · #9"]);
    assert.deepEqual(group(view, UNPLACED).agents.map((a) => a.text), ["inconnu"]);
    assert.equal(view.agentCount, 4);
  });

  test("dans une station, les agents sont triés par issue (sans issue à la fin), puis type, puis identifiant", () => {
    const view = fallbackView(
      modelOf([], [
        agent("z", { issue: null }),
        agent("b", { issue: 8 }),
        agent("a", { issue: 8 }),
        agent("c", { issue: 2 }),
      ]),
    );
    assert.deepEqual(group(view, "dev").agents.map((a) => a.id), ["c", "a", "b", "z"]);
  });
});

describe("fallbackView : pureté", () => {
  test("ne modifie pas le modèle et renvoie le même résultat deux fois", () => {
    const model = modelOf([feature(2, "blocked"), feature(1, "in-progress", { retry: 2 })], [agent("a", { issue: 1 })]);
    deepFreeze(model);
    const first = fallbackView(model);
    assert.deepEqual(fallbackView(model), first);
  });

  test("suit le modèle après un message SSE : la feature change de station, le badge apparaît", () => {
    const model = modelOf([feature(1, "in-progress")]);
    assert.equal(group(fallbackView(model), "dev").features.length, 1);
    const moved = apply(model, evt("feature.status", 5, { issue: 1, status: "in-review" })).model;
    const retried = apply(moved, evt("feature.retry", 6, { issue: 1, retry: 2 })).model;
    const view = fallbackView(retried);
    assert.deepEqual(group(view, "dev").features, []);
    assert.equal(group(view, "verification").features[0].retryBadge, "retry 2");
    const started = apply(retried, evt("agent.requested", 7, { toolUseId: "t1", agentType: "claude-gepet-squad:verificateur", issue: 1 })).model;
    assert.equal(group(fallbackView(started), "verification").agents.length, 1);
  });
});

describe("renderFallback : DOM construit par createElement et textContent", () => {
  const html = '<img src=x onerror="alert(1)">';
  const model = modelOf(
    [feature(1, "ready", { title: "Première" }), feature(2, "in-progress", { title: html, retry: 2 }), feature(3, "blocked", { title: "Bloquée" })],
    [agent("a1", { type: "developpeur", mode: "IMPLEMENTATION", issue: 2, station: undefined })],
  );

  function render(m = model) {
    const container = fakeElement("section");
    renderFallback(container, m, fakeDocument());
    return container;
  }
  const texts = (container) => flatten(container).map((el) => el.textContent);
  const sectionOf = (container, heading) => container.children.find((el) => el.children[0]?.textContent === heading);

  test("un résumé, puis une section par station (plus l'escalade), chacune avec son titre", () => {
    const container = render();
    assert.equal(container.children[0].textContent, "3 features, 1 agent actif");
    const headings = container.children.slice(1).map((section) => section.children[0].textContent);
    assert.deepEqual(headings, ["Cadrage", "Roadmap", "Développement", "Vérification", "Test", "Merge", "Release", "Escalade"]);
    for (const section of container.children.slice(1)) {
      assert.equal(section.tagName, "SECTION");
      assert.equal(section.children[0].tagName, "H2");
      assert.equal(section.attributes["aria-labelledby"], section.children[0].attributes.id, "la section est nommée par son titre");
    }
  });

  test("les features portent leur texte, leur badge retry et leur statut ; les stations vides l'indiquent", () => {
    const container = render();
    const dev = sectionOf(container, "Développement");
    const [features, agents] = dev.children.slice(1);
    assert.equal(features.children.length, 1);
    assert.deepEqual(
      features.children[0].children.map((span) => [span.className, span.textContent]),
      [
        ["repli-titre", `#2 ${html}`],
        ["repli-badge repli-retry", "retry 2"],
        ["repli-badge repli-statut statut-in-progress", "En cours"],
      ],
    );
    assert.deepEqual(
      agents.children[0].children.map((span) => span.textContent),
      ["developpeur · IMPLEMENTATION · #2", "en cours"],
    );
    assert.match(agents.attributes["aria-label"], /Agents actifs/);
    assert.ok(texts(container).includes("aucune feature"), "une station vide l'indique");
    const roadmap = sectionOf(container, "Roadmap");
    assert.deepEqual(roadmap.children[1].children[0].children.map((span) => span.textContent), ["#1 Première", "Prête"], "pas de badge sans tentative");
  });

  test("un titre HTML reste du texte brut : aucun nœud n'est créé à partir de lui (innerHTML lèverait une erreur)", () => {
    const container = render();
    const titled = flatten(container).find((el) => el.textContent === `#2 ${html}`);
    assert.deepEqual(titled.children, []);
    assert.equal(titled.tagName, "SPAN");
    const tags = new Set(flatten(container).map((el) => el.tagName));
    assert.equal(tags.has("IMG"), false);
  });

  test("un nouvel appel remplace le contenu précédent (mise à jour en direct)", () => {
    const container = render();
    const doc = fakeDocument();
    renderFallback(container, modelOf([feature(9, "done", { title: "Seule" })]), doc);
    assert.equal(container.children[0].textContent, "1 feature, 0 agent actif");
    assert.equal(container.children.length, 1 + 7);
    assert.ok(texts(container).includes("#9 Seule"));
    assert.equal(texts(container).some((t) => t.includes("Première")), false, "l'ancien contenu a disparu");
  });
});

describe("css/fallback.css", () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, "css/fallback.css"), "utf8");

  test("une pastille pour chaque statut, de la couleur de la scène et de la légende", () => {
    for (const [status, color] of Object.entries(STATUS_COLORS)) {
      const rule = css.match(new RegExp(`\\.statut-${status}::before\\s*\\{([^}]*)\\}`));
      assert.ok(rule, `règle .statut-${status}`);
      assert.ok(rule[1].includes(`background: ${colorCss(color)};`), `${status} : ${rule[1].trim()}`);
    }
  });

  test("toutes les classes que fallback.js écrit ont une règle, et rien n'est chargé d'externe", () => {
    const view = fallbackView(modelOf([feature(1, "in-progress", { retry: 1 })], [agent("a", { issue: 1 })]));
    assert.ok(view.groups.length > 0);
    const container = fakeElement("section");
    renderFallback(container, modelOf([feature(1, "in-progress", { retry: 1 })], [agent("a", { issue: 1 })]), fakeDocument());
    const classes = new Set(flatten(container).flatMap((el) => el.className.split(/\s+/)).filter(Boolean));
    for (const name of classes) assert.ok(css.includes(`.${name}`), `.${name} sans règle`);
    assert.doesNotMatch(css, /@import|url\(/i);
    assert.doesNotMatch(css, /!important/);
  });

  test("le repli masqué ne s'affiche pas (attribut hidden)", () => {
    assert.match(css, /\.repli\[hidden\]\s*\{\s*display:\s*none;/);
  });
});
