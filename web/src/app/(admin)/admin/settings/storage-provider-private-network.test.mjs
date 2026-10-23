import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../../../../services/api/admin.ts", import.meta.url), "utf8");

test("WebDAV provider exposes and preserves the explicit private-network opt-in", () => {
    assert.ok(/allowPrivateNetwork\??:\s*boolean/.test(api), "AdminStorageProvider must expose the provider opt-in");
    const webdavBranch = page.slice(page.indexOf("{isWebDAV ? ("), page.indexOf(") : (", page.indexOf("{isWebDAV ? (")));
    assert.ok(/Form\.Item name=\{\[field\.name,\s*"allowPrivateNetwork"\]\}/.test(webdavBranch), "the toggle must be inside the WebDAV-only form branch");
    assert.ok(/允许访问内网/.test(webdavBranch), "the WebDAV toggle must explain the network access scope");
    assert.ok(/allowPrivateNetwork:\s*false/.test(page), "new WebDAV providers must default to private-network access disabled");
});
