import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { imageSizeLabel, imageSizeOptions } from "../components/image-settings-panel.tsx";
import { requestGeneration } from "../services/api/image.ts";
import { defaultConfig } from "../stores/use-config-store.ts";
import { useUserStore } from "../stores/use-user-store.ts";

const expectedNewSizes = [
    ["1536x2048", "3:4(2k)"],
    ["3072x4096", "3:4(4k)"],
];
const expectedLow3To4 = [["low", "864x1152"], ["medium", "1776x2368"]];

const expectedExistingSizes = [
    ["1:1", "1:1"],
    ["3:2", "3:2"],
    ["2:3", "2:3"],
    ["4:3", "4:3"],
    ["3:4", "3:4"],
    ["16:9", "16:9"],
    ["9:16", "9:16"],
    ["21:9", "21:9"],
    ["2048x2048", "1:1(2k)"],
    ["2048x1152", "16:9(2k)"],
    ["1152x2048", "9:16(2k)"],
    ["3136x1344", "21:9(2k)"],
    ["3840x2160", "16:9(4k)"],
    ["2160x3840", "9:16(4k)"],
    ["6272x2688", "21:9(4k)"],
    ["auto", "auto"],
];

const sanitize = (config, quality = "medium") => ({
    ...defaultConfig,
    ...config,
    channelMode: "remote",
    model: "gpt-image-2.6-sunburst",
    imageModel: "gpt-image-2.6-sunburst",
    imageChannelId: "ld",
    apiMode: "images",
    quality,
    count: "1",
    imageOutputFormat: "png",
    publicChannels: [{
        id: "ld",
        name: "LD-低价GPT",
        protocol: "openai",
        models: ["gpt-image-2.6-sunburst"],
    }],
});

async function requestBody(t, size, quality = "medium") {
    const originalWindow = globalThis.window;
    const originalState = useUserStore.getState();
    globalThis.window = { location: { pathname: "/image" }, setTimeout, clearTimeout };
    useUserStore.setState({ token: "test-token" });
    const calls = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
        calls.push(init);
        return Response.json({ error: { message: "test-stop" } }, { status: 400 });
    });
    t.after(() => {
        useUserStore.setState(originalState);
        if (originalWindow) globalThis.window = originalWindow;
        else Reflect.deleteProperty(globalThis, "window");
    });
    await assert.rejects(requestGeneration(sanitize({ size }, quality), "size probe"), /test-stop/);
    assert.equal(calls.length, 1);
    return JSON.parse(String(calls[0].body));
}

test("3:4 2K and 4K are appended to their groups with exact portrait dimensions", () => {
    const options = imageSizeOptions.map(({ value, label }) => [value, label]);
    assert.deepEqual(options, [
        ...expectedExistingSizes.slice(0, 8),
        ...expectedExistingSizes.slice(8, 12),
        expectedNewSizes[0],
        ...expectedExistingSizes.slice(12, 15),
        expectedNewSizes[1],
        expectedExistingSizes[15],
    ]);
    for (const [size, label] of expectedNewSizes) {
        assert.equal(imageSizeLabel(size), label);
    }
    const [twoK, fourK] = expectedNewSizes;
    assert.ok(imageSizeLabel(twoK[0]).includes("(2k)"));
    assert.ok(imageSizeLabel(fourK[0]).includes("(4k)"));
    assert.equal(Number(twoK[0].split("x")[0]) / Number(twoK[0].split("x")[1]), 3 / 4);
    assert.equal(Number(fourK[0].split("x")[0]) / Number(fourK[0].split("x")[1]), 3 / 4);
    assert.equal(Math.max(...fourK[0].split("x").map(Number)), 4096);
});

test("workbench request bodies send exact 1536x2048 and 3072x4096 sizes", async t => {
    for (const [size] of expectedNewSizes) {
        const body = await requestBody(t, size);
        assert.equal(body.size, size);
    }
});

test("guard: existing 1K 3:4 keeps its ratio, label and quality-derived dimensions", async t => {
    for (const [quality, expected] of expectedLow3To4) {
        assert.equal((await requestBody(t, "3:4", quality)).size, expected, quality);
    }
    assert.equal(imageSizeLabel("3:4"), "3:4");
});

test("guard: existing 2K and 4K options keep their labels and sizes", async t => {
    for (const [size, label] of expectedExistingSizes.slice(8, 15)) {
        assert.equal(imageSizeLabel(size), label, size);
        assert.equal((await requestBody(t, size)).size, size, size);
    }
});

test("guard: all existing ratio options remain unchanged", () => {
    for (const [size, label] of expectedExistingSizes.slice(0, 8)) {
        assert.equal(imageSizeLabel(size), label, size);
    }
});

test("guard: source defines both new entries once with portrait orientation", () => {
    const source = readFileSync(new URL("../components/image-settings-panel.tsx", import.meta.url), "utf8");
    assert.equal((source.match(/value: "3:4-2k"/g) || []).length, 1);
    assert.equal((source.match(/value: "3:4-4k"/g) || []).length, 1);
    assert.match(source, /\{ value: "3:4-2k", label: "3:4\(2k\)", size: "1536x2048", width: 1536, height: 2048, icon: "portrait" \}/);
    assert.match(source, /\{ value: "3:4-4k", label: "3:4\(4k\)", size: "3072x4096", width: 3072, height: 4096, icon: "portrait" \}/);
});
