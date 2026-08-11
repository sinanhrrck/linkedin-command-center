const { spawnSync } = require("node:child_process");
const path = require("node:path");

const playwrightCli = path.join(path.dirname(require.resolve("playwright")), "cli.js");
const result = spawnSync(process.execPath, [playwrightCli, "install", "chromium"], {
  cwd: path.resolve(__dirname, ".."),
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
