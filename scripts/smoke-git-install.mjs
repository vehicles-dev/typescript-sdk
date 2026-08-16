import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = mkdtempSync(join(tmpdir(), "vehicles-sdk-git-install-"));
const sourceCheckout = join(temporaryRoot, "source");
const consumer = join(temporaryRoot, "consumer");
const excludedRoots = new Set([".git", "dist", "node_modules"]);

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

try {
  cpSync(repositoryRoot, sourceCheckout, {
    filter(source) {
      const path = relative(repositoryRoot, source);
      if (path.length === 0) return true;
      const root = path.split(sep)[0];
      return root !== undefined && !excludedRoots.has(root) && !path.endsWith(".tgz");
    },
    recursive: true
  });

  if (existsSync(join(sourceCheckout, "dist"))) {
    throw new Error("The clean Git-source fixture unexpectedly contains dist before installation.");
  }

  run("git", ["init", "--quiet"], sourceCheckout);
  run("git", ["add", "--all"], sourceCheckout);
  run(
    "git",
    [
      "-c",
      "user.name=Vehicles SDK Smoke",
      "-c",
      "user.email=smoke@vehicles.dev",
      "commit",
      "--quiet",
      "-m",
      "Git install fixture"
    ],
    sourceCheckout
  );

  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "vehicles-sdk-git-install-smoke", private: true, type: "module" })
  );
  const sourceUrl = `git+${pathToFileURL(sourceCheckout).href}`;
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", sourceUrl], consumer);

  const installedEntry = join(consumer, "node_modules", "@vehicles-dev", "sdk", "dist", "index.js");
  if (!existsSync(installedEntry)) {
    throw new Error("Git-source installation did not build dist/index.js.");
  }

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { Vehicles, VehiclesError } from "@vehicles-dev/sdk"; const client = new Vehicles({ apiKey: "smoke-only" }); if (!client.historyReports || typeof VehiclesError !== "function") throw new Error("SDK exports are incomplete");'
    ],
    consumer
  );
  console.log("Clean Git-source install and ESM import: OK");
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
