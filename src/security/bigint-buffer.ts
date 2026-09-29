// GHSA-3gc7-fjrx-p6mg has no patched release. Force the upstream pure-JS
// implementation before any Solana imports can load the native addon.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const layoutRequire = createRequire(require.resolve("@solana/buffer-layout-utils"));
const entry = layoutRequire.resolve("bigint-buffer");
const browserEntry = layoutRequire.resolve("bigint-buffer/dist/browser.js");
const metadata = layoutRequire("bigint-buffer/package.json");
if (metadata.version !== "1.1.5" || require.cache[entry]) {
  throw new Error("bigint-buffer mitigation needs review before startup");
}
layoutRequire(browserEntry);
const safeModule = require.cache[browserEntry];
if (!safeModule) throw new Error("Pure-JS bigint-buffer could not be loaded");
require.cache[entry] = safeModule;
