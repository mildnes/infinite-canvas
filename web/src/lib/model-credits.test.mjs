import assert from "node:assert/strict";
import test from "node:test";

import { formatCreditQuote, indexModelCredits, requestCreditQuote } from "./model-credits.ts";

const channels = [
    { id: "a", enabled: true, models: ["shared", "new"] },
    { id: "b", enabled: true, models: ["shared"] },
    { id: "off", enabled: false, models: ["shared"] },
];
const costIndex = indexModelCredits([
    { channelId: "a", model: "shared", credits: 7 },
    { channelId: "b", model: "shared", credits: 18 },
    { channelId: "off", model: "shared", credits: 99 },
]);

test("同名模型按选定渠道与张数报价", () => {
    const quote = requestCreditQuote({ channelMode: "remote", channels, costIndex, channelId: "b", model: "shared", count: 3 });
    assert.deepEqual(quote, { min: 54, max: 54 });
    assert.equal(formatCreditQuote(quote), "54");
});

test("未指定渠道时展示可能的价格范围，忽略停用渠道", () => {
    const quote = requestCreditQuote({ channelMode: "remote", channels, costIndex, model: "shared", count: 2 });
    assert.deepEqual(quote, { min: 14, max: 36 });
    assert.equal(formatCreditQuote(quote), "14–36");
});

test("新模型未定价为零，本地直连不扣算力点", () => {
    assert.deepEqual(requestCreditQuote({ channelMode: "remote", channels, costIndex, channelId: "a", model: "new" }), { min: 0, max: 0 });
    assert.deepEqual(requestCreditQuote({ channelMode: "local", channels, costIndex, channelId: "b", model: "shared" }), { min: 0, max: 0 });
});

test("无效渠道使用可用渠道范围，多图张数最多按 15 张报价", () => {
    assert.deepEqual(requestCreditQuote({ channelMode: "remote", channels, costIndex, channelId: "missing", model: "shared", count: 99 }), { min: 105, max: 270 });
});

test("系统工作流按指定渠道固定每次报价，个人工作流不扣点", () => {
    const workflowModel = "workflow:system:a:workflow:123";
    const workflowCosts = indexModelCredits([{ channelId: "a", model: workflowModel, credits: 25 }]);
    assert.deepEqual(requestCreditQuote({ channelMode: "remote", channels, costIndex: workflowCosts, channelId: "a", model: workflowModel }), { min: 25, max: 25 });
    assert.deepEqual(requestCreditQuote({ channelMode: "local", channels, costIndex: workflowCosts, channelId: "a", model: workflowModel }), { min: 0, max: 0 });
});
