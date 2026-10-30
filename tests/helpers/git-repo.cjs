// Repo git temporaire (avec worktree optionnel) pour les tests d'intégration.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let configVide = null;

/**
 * Fichier de configuration git vide : git sous Windows n'accepte pas os.devNull (\\.\nul).
 * Créé une fois par processus de test, supprimé à la sortie.
 */
function fichierConfigVide() {
  if (!configVide || !fs.existsSync(configVide)) {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-gitconfig-"));
    configVide = path.join(dossier, "gitconfig");
    fs.writeFileSync(configVide, "");
    process.on("exit", () => fs.rmSync(dossier, { recursive: true, force: true }));
  }
  return configVide;
}

/** Environnement git isolé de la configuration de l'utilisateur. */
function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: fichierConfigVide(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(cwd, args) {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** Dossier commun `.git` vu depuis `cwd`, en chemin absolu et canonique. */
function gitCommonDir(cwd) {
  const out = git(cwd, ["rev-parse", "--git-common-dir"]);
  return fs.realpathSync(path.resolve(cwd, out));
}

/**
 * Crée un repo git dans un dossier temporaire, avec un premier commit sur `main`.
 * @param {{ withWorktree?: boolean }} options
 * @returns {{ dir: string, worktreeDir: string|null, git: (cwd: string, args: string[]) => string, cleanup: () => void }}
 */
function createTempRepo({ withWorktree = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gepet-repo-")));
  const dir = path.join(root, "repo");
  fs.mkdirSync(dir);
  git(dir, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo de test\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "chore: commit initial"]);

  let worktreeDir = null;
  if (withWorktree) {
    worktreeDir = path.join(root, "worktree");
    git(dir, ["worktree", "add", "-b", "feature/test", worktreeDir]);
  }

  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { dir, worktreeDir, git, cleanup };
}

module.exports = { createTempRepo, gitCommonDir, gitEnv };
