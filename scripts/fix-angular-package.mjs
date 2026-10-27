import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve("dist/package.json");
const pkg = JSON.parse(readFileSync(file, "utf8"));

pkg.main = "./fesm2022/p2plink-angular.mjs";
pkg.module = "./fesm2022/p2plink-angular.mjs";
pkg.types = "./types/p2plink-angular.d.ts";
pkg.exports = {
  ".": {
    types: "./types/p2plink-angular.d.ts",
    default: "./fesm2022/p2plink-angular.mjs",
  },
  "./package.json": "./package.json",
};
pkg.files = ["fesm2022", "types", "README.md", "LICENSE"];
for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
  if (typeof version === "string" && version.startsWith("workspace:")) {
    pkg.dependencies[name] = "^0.1.0";
  }
}
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
