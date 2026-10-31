// Installation d'un faux `gh` dans un dossier temporaire, à placer en tête du PATH d'un sous-processus.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// Arguments transmis à travers le shell de Windows sans échappement : on n'accepte que des caractères sûrs.
const ARGUMENT_SIMPLE = /^[\w@%+=:,./\\-]+$/;

/**
 * Construit un environnement dont le PATH commence par `dir`.
 * Fonction pure : `platform` est un paramètre pour pouvoir la tester pour Windows depuis Linux.
 * Sous Windows la variable s'appelle souvent `Path` : on la retrouve sans tenir compte de la casse.
 */
function buildEnv(dir, baseEnv, platform = process.platform) {
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
  const env = { ...baseEnv };
  const key =
    platform === "win32"
      ? Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH"
      : "PATH";
  env[key] = env[key] ? `${dir}${delimiter}${env[key]}` : dir;
  return env;
}

/**
 * Crée un dossier temporaire contenant `gh` (POSIX), `gh.cmd` (Windows), le script `fake-gh.cjs`
 * et les réponses de fixture.
 * @param {{ routes: object[] }} responses réponses JSON, voir fake-gh.cjs
 * @returns {{ dir: string, env: (baseEnv?: object) => object, calls: () => object[], run: Function, cleanup: () => void }}
 */
function installFakeGh(responses = { routes: [] }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gepet-fakegh-")));
  fs.copyFileSync(path.join(__dirname, "fake-gh.cjs"), path.join(dir, "fake-gh.cjs"));
  fs.writeFileSync(path.join(dir, "responses.json"), JSON.stringify(responses));

  // Chemin absolu de Node : le faux gh ne dépend pas du PATH de l'appelant pour trouver `node`.
  const node = process.execPath;
  fs.writeFileSync(
    path.join(dir, "gh"),
    `#!/bin/sh\nexec "${node}" "$(dirname "$0")/fake-gh.cjs" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "gh.cmd"), `@echo off\r\n"${node}" "%~dp0fake-gh.cjs" %*\r\n`);

  const env = (baseEnv = process.env) => buildEnv(dir, baseEnv);

  const calls = () => {
    const file = path.join(dir, "calls.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };

  /**
   * Exécute `gh` via execFile avec le PATH du faux gh. Résout toujours : { code, stdout, stderr }.
   * Sous Windows, Node refuse d'exécuter un .cmd sans shell : on passe par le shell, avec des
   * arguments simples : les autres sont refusés explicitement (rejet de la promesse).
   */
  const run = (args, options = {}) =>
    new Promise((resolve) => {
      // Même contrôle sur tous les OS pour que les tests se comportent partout de la même façon.
      for (const arg of args) {
        if (!ARGUMENT_SIMPLE.test(arg)) {
          throw new Error(`gh.run : argument non pris en charge (espace ou métacaractère de shell) : ${JSON.stringify(arg)}`);
        }
      }
      const isWin = process.platform === "win32";
      execFile(
        isWin ? "gh.cmd" : "gh",
        args,
        { env: env(), shell: isWin, encoding: "utf8", ...options },
        (error, stdout, stderr) => {
          resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
        },
      );
    });

  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

  return { dir, env, calls, run, cleanup };
}

module.exports = { buildEnv, installFakeGh };
