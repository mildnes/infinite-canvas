import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./external-media-url.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(code, { exports, module: { exports }, URL, window: { location: { origin: "https://canvas.example" } } });

test("external media URLs reject the app origin, local hosts, and non-http schemes", () => {
    assert.equal(exports.externalMediaURL("/api/files/object/content"), "");
    assert.equal(exports.externalMediaURL("https://canvas.example/api/files/object/content"), "");
    assert.equal(exports.externalMediaURL("http://127.0.0.1:8080/media"), "");
    assert.equal(exports.externalMediaURL("data:image/png;base64,AAAA"), "");
    assert.equal(exports.externalMediaURL("https://cdn.example/media.png"), "https://cdn.example/media.png");
});

test("canvas and video source code no longer preserves same-origin media as public URLs", () => {
    const sourceAt = (relative) => process.env.BASELINE_SHA
        ? execFileSync("git", ["show", `${process.env.BASELINE_SHA}:${relative}`], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" })
        : readFileSync(new URL(`../${relative.replace(/^web\/src\//, "")}`, import.meta.url), "utf8");
    const video = sourceAt("web/src/services/api/video.ts");
    const canvas = sourceAt("web/src/app/(user)/canvas/components/canvas-node-generation.ts");
    assert.match(video, /externalMediaURL/);
    assert.doesNotMatch(video, /publicHttpUrl\(resolvedUrl\) \|\| publicHttpUrl\(reference\.url\) \|\| resolvedUrl \|\| reference\.url/);
    assert.doesNotMatch(canvas, /const remoteUrl = \[image\.url, image\.dataUrl\]\.find\(isAbsoluteHttpUrl\)/);
});
