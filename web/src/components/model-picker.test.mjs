import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
};
for (const key of ["Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "DocumentFragment"]) globals[key] = dom.window[key];
const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, globals);
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
dom.window.PointerEvent = class extends dom.window.MouseEvent {
    constructor(type, options = {}) {
        super(type, options);
        Object.defineProperties(this, {
            pointerId: { value: options.pointerId ?? 1 },
            pointerType: { value: options.pointerType ?? "mouse" },
        });
    }
};
dom.window.requestAnimationFrame = globals.requestAnimationFrame;
dom.window.cancelAnimationFrame = globals.cancelAnimationFrame;

// Radix portals need the DOM to exist before their first import.
const { ModelPicker } = await import("./model-picker.tsx");
const { defaultConfig, useConfigStore } = await import("../stores/use-config-store.ts");
const { useUserStore } = await import("../stores/use-user-store.ts");
let root;
let changes;
const channelA = { id: "a", name: "渠道乙", protocol: "openai", models: ["图像乙", "同名图像"], modelCapabilities: { "图像乙": ["image"], "同名图像": ["image"] } };
const channelB = { id: "b", name: "渠道甲", protocol: "openai", models: ["同名图像", "图像甲"], modelCapabilities: { "同名图像": ["image"], "图像甲": ["image"] } };
const config = { ...defaultConfig, channelMode: "remote", publicChannels: [channelA, channelB] };

beforeEach(() => {
    useUserStore.setState({ token: "test-user", user: { id: "user" }, isReady: true });
    useConfigStore.setState({ publicSettings: { modelChannel: {} } });
    root = createRoot(document.getElementById("root"));
    changes = [];
});
afterEach(async () => {
    await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});
after(() => {
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    }
});

async function render(props = {}) {
    await act(async () => root.render(React.createElement(ModelPicker, {
        config, capability: "image", value: "同名图像", channelId: "b",
        onChange: (...args) => changes.push(args), ...props,
    })));
}

async function click(element) {
    assert.ok(element, "交互目标必须存在");
    await act(async () => {
        element.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, ctrlKey: false }));
        element.dispatchEvent(new dom.window.PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
        element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
}

function channels() {
    return [...document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')];
}
async function openChannel(name) {
    const item = channels().find((item) => item.getAttribute("aria-label") === name);
    assert.ok(item, `一级菜单应包含渠道「${name}」`);
    await click(item);
    return item;
}
function models() {
    return [...document.querySelectorAll('[role="menuitemradio"]')];
}

test("一级菜单按配置顺序只展示渠道，展开后才展示该渠道的模型", async () => {
    await render();
    await click(document.querySelector("button"));
    assert.deepEqual(channels().map((item) => item.getAttribute("aria-label")), ["渠道乙", "渠道甲"]);
    assert.equal(models().length, 0);
    await openChannel("渠道乙");
    assert.deepEqual(models().map((item) => item.getAttribute("data-model")), ["图像乙", "同名图像"]);
    assert.deepEqual(changes, [], "点击渠道只能展开，不能更改模型");
});

test("同名模型保留渠道绑定，选择二级菜单后关闭并回传准确渠道", async () => {
    await render();
    await click(document.querySelector("button"));
    await openChannel("渠道甲");
    const selected = models().find((item) => item.getAttribute("data-model") === "同名图像");
    assert.equal(selected?.getAttribute("aria-checked"), "true");
    await act(async () => selected.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    await openChannel("渠道乙");
    const shared = models().find((item) => item.getAttribute("data-model") === "同名图像");
    assert.equal(shared?.getAttribute("aria-checked"), "false");
    await click(shared);
    assert.deepEqual(changes, [["同名图像", "a"]]);
    assert.equal(document.querySelector('[role="menu"]'), null);
});

test("能力过滤保留映射别名、剔除无匹配模型渠道，本地模式也按渠道分层", async () => {
    const localChannels = [
        { ...channelB, apiKey: "", baseUrl: "" },
        { id: "text", name: "文本渠道", protocol: "openai", apiKey: "", baseUrl: "", models: ["文本模型"], modelCapabilities: { "文本模型": ["text"] } },
        { id: "alias", name: "别名渠道", protocol: "openai", apiKey: "", baseUrl: "", models: ["我的高质图"], modelMap: { "我的高质图": "gpt-image-2" } },
    ];
    await render({ config: { ...config, channelMode: "local", localChannels } });
    await click(document.querySelector("button"));
    assert.deepEqual(channels().map((item) => item.getAttribute("aria-label")), ["渠道甲", "别名渠道"]);
    await openChannel("别名渠道");
    await click(models()[0]);
    assert.deepEqual(changes, [["我的高质图", "alias"]]);
});

test("工作流按所属渠道和原顺序显示，选择仍返回完整工作流引用", async () => {
    const workflow = { provider: "runninghub", kind: "workflow", workflowId: "workflow-1", title: "修图工作流", capability: "image", enabled: true };
    const ref = { scope: "system", channelId: "workflow", kind: "workflow", workflowId: "workflow-1" };
    const workflowChanges = [];
    await render({
        config: { ...config, publicChannels: [{ id: "workflow", name: "工作流渠道", protocol: "runninghub", workflows: [workflow, { ...workflow, workflowId: "disabled", enabled: false }] }, channelA] },
        value: "同名图像", channelId: "a", onWorkflowChange: (next) => workflowChanges.push(next),
    });
    await click(document.querySelector("button"));
    assert.deepEqual(channels().map((item) => item.getAttribute("aria-label")), ["工作流渠道", "渠道乙"]);
    await openChannel("工作流渠道");
    assert.equal(models().length, 1);
    assert.ok(models()[0].textContent.includes("修图工作流"));
    await click(models()[0]);
    assert.deepEqual(workflowChanges, [ref]);
    assert.deepEqual(changes, []);
});

test("键盘可展开渠道和选择模型，Escape 关闭菜单", async () => {
    await render();
    const trigger = document.querySelector("button");
    await act(async () => trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    const firstChannel = channels()[0];
    assert.ok(firstChannel, "键盘打开后应展示一级渠道");
    await act(async () => {
        firstChannel.focus();
        firstChannel.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    assert.equal(models().length, 2);
    await act(async () => {
        models()[0].focus();
        models()[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    assert.deepEqual(changes, [["图像乙", "a"]]);
    await click(trigger);
    await act(async () => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
});

test("打开另一个选择器会关闭已有的两级菜单", async () => {
    const props = { config, capability: "image", value: "同名图像", channelId: "b", onChange: (...args) => changes.push(args) };
    await act(async () => root.render(React.createElement("div", null,
        React.createElement(ModelPicker, { ...props, placeholder: "Agent 模型" }),
        React.createElement(ModelPicker, { ...props, placeholder: "画板模型" }),
    )));
    const buttons = document.querySelectorAll("button");
    await click(buttons[0]);
    await openChannel("渠道乙");
    await click(buttons[1]);
    assert.equal(buttons[0].getAttribute("aria-expanded"), "false");
    assert.equal(buttons[1].getAttribute("aria-expanded"), "true");
    assert.equal(models().length, 0);
    assert.equal(document.querySelectorAll('[role="menu"]').length, 1);
});

test("无权限保持远端空态，本地无模型仍引导配置", async () => {
    await render({ config: { ...config, publicChannels: [] }, value: "", channelId: "" });
    assert.ok(document.querySelector("button").textContent.includes("当前分组没有可用的图片模型"));
    await click(document.querySelector("button"));
    assert.equal(channels().length, 0);
    assert.ok(document.body.textContent.includes("暂无可用模型"));
    let missing = 0;
    await render({ key: "local", config: { ...defaultConfig, models: [], localChannels: [] }, value: "", channelId: "", onMissingConfig: () => { missing += 1; } });
    await click(document.querySelector("button"));
    assert.equal(missing, 1);
    assert.equal(document.querySelector('[role="menu"]'), null);
});
