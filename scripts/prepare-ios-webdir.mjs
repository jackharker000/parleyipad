// Assemble the static web bundle that ships inside the native iPad app.
//
// A CAP_BUILD=1 vite build produces the SPA shell as `.output/public/_shell.html`
// alongside every static asset. Capacitor needs a plain folder with index.html
// at its root, so this copies the build output to `dist-ios/` and promotes the
// shell to index.html. Run via `bun run build:ios` (never by hand between
// builds — the folder is regenerated from scratch each time).
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC = ".output/public";
const DEST = "dist-ios";
const SHELL = join(DEST, "_shell.html");
const INDEX = join(DEST, "index.html");

if (!existsSync(join(SRC, "_shell.html"))) {
  console.error(
    `[prepare-ios-webdir] ${SRC}/_shell.html not found — run "CAP_BUILD=1 vite build" first ` +
      `(the plain web build has no SPA shell).`,
  );
  process.exit(1);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });
renameSync(SHELL, INDEX);
console.log(`[prepare-ios-webdir] ${SRC} → ${DEST} (shell promoted to index.html)`);
