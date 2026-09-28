import assert from "node:assert/strict";
import test from "node:test";

import { directAIProviderForProtocol, isWorkflowProtocol, modelChannelApiKeyUrls, modelChannelDefaultBaseUrls, modelChannelProtocolOptions } from "./model-channel";

test("built-in protocols retain the supported channel order", () => {
    assert.deepEqual(modelChannelProtocolOptions, [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
        { label: "Grok2API", value: "grok2api" },
        { label: "xAI", value: "xai" },
        { label: "MiniMax & METASO", value: "metaso" },
        { label: "APIMart", value: "apimart" },
        { label: "KIE", value: "kie" },
        { label: "MiMo", value: "mimo" },
        { label: "火山方舟", value: "ark" },
        { label: "RunningHub", value: "runninghub" },
        { label: "ComfyUI", value: "comfyui" },
    ]);
});

test("built-in channels keep their default endpoints and key links", () => {
    assert.equal(modelChannelDefaultBaseUrls.openai, "https://api.openai.com");
    assert.equal(modelChannelDefaultBaseUrls.xai, "https://api.x.ai");
    assert.equal(modelChannelDefaultBaseUrls.runninghub, "https://www.runninghub.cn");
    assert.equal(modelChannelDefaultBaseUrls.comfyui, "");
    assert.equal(modelChannelApiKeyUrls.apimart, "https://apimart.ai/register?aff=fWMrEv");
    assert.equal(modelChannelApiKeyUrls.mimo, "https://platform.xiaomimimo.com/?ref=JFZQR2");
});

test("direct provider lookup uses exact protocol values", () => {
    assert.equal(directAIProviderForProtocol("kie"), "kie");
    assert.equal(directAIProviderForProtocol("apimart"), "apimart");
    assert.equal(directAIProviderForProtocol("ark"), "ark");
    for (const protocol of ["openai", "gemini", "xai", "grok2api", "runninghub", "comfyui", "KIE", " kie ", "unknown"]) {
        assert.equal(directAIProviderForProtocol(protocol), null, protocol);
    }
});

test("workflow protocols are separate from direct model channels", () => {
    assert.equal(isWorkflowProtocol("runninghub"), true);
    assert.equal(isWorkflowProtocol("comfyui"), true);
    assert.equal(isWorkflowProtocol("openai"), false);
});
