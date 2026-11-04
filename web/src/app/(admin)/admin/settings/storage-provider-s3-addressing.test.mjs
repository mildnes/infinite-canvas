import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../../../../services/api/admin.ts", import.meta.url), "utf8");

test("S3 provider exposes vendor and addressing fields without changing WebDAV", () => {
    assert.ok(/s3Provider\?:/.test(api), "AdminStorageProvider must persist the S3 vendor");
    assert.ok(/s3AddressingStyle\?:/.test(api), "AdminStorageProvider must persist the S3 addressing style");
    const s3Start = page.indexOf("{!isWebDAV && (");
    const s3Branch = page.slice(s3Start, page.indexOf("</>", s3Start));
    assert.ok(/name=\{\[field\.name,\s*"s3Provider"\]\}/.test(s3Branch), "vendor selector must be inside S3-only branch");
    assert.ok(/name=\{\[field\.name,\s*"s3AddressingStyle"\]\}/.test(s3Branch), "addressing selector must be inside S3-only branch");
    assert.ok(/腾讯云 COS/.test(s3Branch) && /阿里云 OSS/.test(s3Branch) && /Bucket 路径/.test(s3Branch) && /Bucket 子域名/.test(s3Branch), "both vendor and addressing choices must be visible");
});

test("S3 provider defaults preserve legacy path-style and normalize loaded values", () => {
    assert.ok(/s3Provider:\s*"s3"/.test(page), "new providers must default to AWS S3");
    assert.ok(/s3AddressingStyle:\s*"path"/.test(page), "new and legacy providers must keep path-style");
    const normalize = page.slice(page.indexOf("function normalizeStorageProvider"), page.indexOf("function newAdminStorageProvider"));
    assert.ok(/item\.s3Provider\s*\|\|\s*"s3"/.test(normalize), "loaded providers must retain or default the vendor");
    assert.ok(/item\.s3AddressingStyle\s*\|\|\s*"path"/.test(normalize), "loaded providers must retain or default the addressing style");
});
