import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const moduleUrl = new URL("./same-origin-public-media-url.ts", import.meta.url);
function mediaUrl(value, origin, pageOrigin = "https://canvas.example:4443") {
    const exports = {};
    if (existsSync(moduleUrl)) {
        const source = readFileSync(moduleUrl, "utf8");
        const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
        vm.runInNewContext(code, { exports, URL, ...(pageOrigin ? { window: { location: { origin: pageOrigin } } } : {}) });
    }
    assert.equal(typeof exports.sameOriginPublicMediaUrl, "function", "same-origin public media resolver must be implemented");
    return exports.sameOriginPublicMediaUrl(value, origin);
}

test("公网页面的 content/preview 路径补全绝对 URL，保留端口、查询和片段", () => {
    assert.equal(mediaUrl("/api/files/object-id/content"), "https://canvas.example:4443/api/files/object-id/content");
    assert.equal(mediaUrl("/api/files/object-id/preview?size=small#view"), "https://canvas.example:4443/api/files/object-id/preview?size=small#view");
    assert.equal(mediaUrl("https://canvas.example:4443/api/files/object-id/content"), "https://canvas.example:4443/api/files/object-id/content");
    assert.equal(mediaUrl("/api/files/id/content", "http://canvas.example:8080"), "http://canvas.example:8080/api/files/id/content");
});

test("只允许指定同源媒体路径，其他同源接口、跨域、凭据及非 HTTP 素材不放行", () => {
    for (const value of [
        undefined, "", "   ", "blob:https://canvas.example:4443/blob", "data:image/png;base64,AAAA", "file:///api/files/id/content",
        "/api/user-data/assets/id/content", "/api/files/id/content/extra", "/api/files/id/thumbnail", "/api/files//content",
        "/api/files/id/../content", "/api/files/id/content/../../auth", "/api/files/id/preview/", "/api/files/id/content-extra",
        "https://other.example/api/files/id/content", "//other.example/api/files/id/preview", "https://user:password@canvas.example:4443/api/files/id/content",
    ]) assert.equal(mediaUrl(value), "", String(value));
});

test("私网、回环和 local 页面来源全部拒绝，包括规范化的 IPv4 与 IPv6 地址", () => {
    for (const host of [
        "localhost", "localhost.", "canvas.localhost", "127.0.0.1", "127.12.3.4", "127.1", "2130706433", "0x7f000001",
        "10.10.10.143", "10.0.0.1", "192.168.1.6", "172.16.0.1", "172.31.255.254", "canvas.local", "CANVAS.LOCAL.",
        "0.0.0.0", "169.254.1.2", "[::1]", "[::]", "[fc00::1]", "[fd12::1]", "[fe80::1]", "[::ffff:192.168.1.6]",
    ]) assert.equal(mediaUrl("/api/files/id/content", `http://${host}:3000`), "", host);
});

test("私网范围边界之外与公网 IPv6 不误拦，origin 缺失或协议非法时拒绝", () => {
    for (const host of ["172.15.255.254", "172.32.0.1", "192.169.1.1", "8.8.8.8", "[2001:db8::1]", "[2606:4700:4700::1111]", "local.example"])
        assert.equal(mediaUrl("/api/files/id/content", `https://${host}`), `https://${host}/api/files/id/content`, host);
    for (const origin of ["null", "not a URL", "file:///tmp/page", "ftp://canvas.example", "data:text/plain,page"])
        assert.equal(mediaUrl("/api/files/id/content", origin), "", origin);
    assert.equal(mediaUrl("https://canvas.example/api/files/id/content", undefined, ""), "");
    assert.equal(mediaUrl("/api/files/id/content", "https://canvas.example", ""), "https://canvas.example/api/files/id/content");
});
