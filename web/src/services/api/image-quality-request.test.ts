import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_QUALITY_OPTIONS } from "@/lib/image-quality";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { createCanvasImageTask, requestEdit, requestGeneration } from "./image";

const reference = { id: "test-reference", name: "source.png", type: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };

test("Codex compatibility preserves all six qualities in real workbench and canvas requests", async (t) => {
    const originalToken = useUserStore.getState().token;
    const originalWindow = globalThis.window;
    useUserStore.setState({ token: "test-token" });
    globalThis.window = { location: { pathname: "/canvas/test" }, setTimeout, clearTimeout } as unknown as Window & typeof globalThis;
    t.after(() => {
        useUserStore.setState({ token: originalToken });
        if (originalWindow) globalThis.window = originalWindow;
        else Reflect.deleteProperty(globalThis, "window");
    });

    const sentRequests: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        sentRequests.push(init);
        // Deliberately stop before result persistence; no real upstream request.
        return new Response(JSON.stringify({ error: { message: "test-stop" } }), { status: 400 });
    });
    const cases = [
        { name: "workbench Images", apiMode: "images", run: requestGeneration, references: false },
        { name: "workbench edit", apiMode: "images", run: requestEdit, references: true },
        { name: "workbench Responses", apiMode: "responses", run: requestGeneration, references: false },
        { name: "canvas Images", apiMode: "images", run: createCanvasImageTask, references: false },
        { name: "canvas edit", apiMode: "images", run: createCanvasImageTask, references: true },
        { name: "canvas Responses", apiMode: "responses", run: createCanvasImageTask, references: false },
    ];
    for (const scenario of cases) {
        for (const codexCli of ["", "1"]) {
            for (const { value } of IMAGE_QUALITY_OPTIONS) {
                const config = { ...defaultConfig, channelMode: "remote" as const, model: "custom-image", imageModel: "custom-image", apiMode: scenario.apiMode, codexCli, quality: value, count: "1", size: "1024x1024" };
                sentRequests.length = 0;
                await assert.rejects(() => scenario.run(config, "test scene", scenario.references ? [reference] : []));
                const sent = sentRequests[0];
                assert.ok(sent, `${scenario.name} should send a request`);
                if (sent.body instanceof FormData) {
                    assert.equal(sent.body.get("quality"), value, `${scenario.name}: ${codexCli}/${value}`);
                    assert.equal((sent.body.get("image") as File).size, 8, "reference bytes must survive");
                } else {
                    const body = JSON.parse(String(sent.body));
                    const request = body.request || body;
                    const target = scenario.apiMode === "responses" ? request.tools[0] : request;
                    assert.equal(target.quality, value, `${scenario.name}: ${codexCli}/${value}`);
                    if (codexCli) assert.match(String(request.prompt || request.input), /Do not rewrite it/);
                }
            }
        }
    }
});
