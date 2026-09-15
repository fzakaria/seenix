// Tests that every module and worker the page loads parses. Most of them
// touch the DOM, WebGL or workers and cannot be imported under node, so a
// syntax error in one would otherwise surface only as a blank page. Each
// file is handed to `node --check`, which parses without running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const siteJs = fileURLToPath(new URL("../../site/js/", import.meta.url));

// Every .js file under site/js, workers included, as paths.
function modules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      return modules(`${path}/`);
    }
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

for (const path of modules(siteJs)) {
  test(`${path.slice(siteJs.length)} parses`, () => {
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" }),
    );
  });
}
