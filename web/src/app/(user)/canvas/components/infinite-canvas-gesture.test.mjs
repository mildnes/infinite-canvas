import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { InfiniteCanvas } from "./infinite-canvas.tsx";

function setupDom() {
    const dom = new JSDOM("<div id='root'></div>");
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true,
        Element: dom.window.Element,
        HTMLElement: dom.window.HTMLElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        HTMLSelectElement: dom.window.HTMLSelectElement,
        KeyboardEvent: dom.window.KeyboardEvent,
        HTMLMediaElement: dom.window.HTMLMediaElement,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    });
    globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
    dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    dom.window.setTimeout = (callback, timeout) => globalThis.setTimeout(callback, timeout);
    dom.window.clearTimeout = (id) => globalThis.clearTimeout(id);
    return { dom, previous };
}

function restoreDom({ dom, previous }) {
    Object.assign(globalThis, previous);
    dom.window.close();
}

function worldAt(container, viewport, mouseX, mouseY) {
    const rect = container.getBoundingClientRect();
    return {
        x: (mouseX - rect.left - viewport.x) / viewport.k,
        y: (mouseY - rect.top - viewport.y) / viewport.k,
    };
}

function dispatchWheel(container, clientX, clientY, deltaY) {
    const event = new container.ownerDocument.defaultView.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        deltaY,
    });
    container.dispatchEvent(event);
}

function pointerEvent(view, type, clientX, clientY, options = {}) {
    const event = new view.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
        buttons: options.buttons ?? 1,
        pointerId: 1,
        ...options,
    });
    Object.defineProperty(event, "pointerId", { value: options.pointerId ?? 1 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    return event;
}

test("wheel gestures update transform without React commits, then commit once", async () => {
    const context = setupDom();
    try {
        const root = createRoot(context.dom.window.document.getElementById("root"));
        let pageCommits = 0;
        let nodeRenders = 0;
        let viewport = { x: 40, y: 24, k: 1 };
        const viewportRef = { current: viewport };
        const scaleRef = { current: viewport.k };
        const setViewport = (next) => {
            pageCommits += 1;
            viewport = next;
        };
        const container = { current: null };
        await act(async () => {
            root.render(
                React.createElement(
                    InfiniteCanvas,
                    { containerRef: container, viewport, viewportRef, scaleRef, tool: "select", onViewportChange: setViewport },
                    React.createElement(() => {
                        nodeRenders += 1;
                        return React.createElement("div", { "data-node-id": "node-1", style: { position: "absolute", width: 100, height: 100 } }, "node");
                    }),
                ),
            );
        });
        container.current.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800 });
        const anchorBefore = worldAt(container.current, viewport, 600, 400);
        const anchorsRef = [worldAt(container.current, viewportRef.current, 600, 400)];

        for (let index = 0; index < 30; index += 1) {
            dispatchWheel(container.current, 600, 400, -100);
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 1));
            });
        }

        const transformLayer = [...container.current.children].find((child) => child.getAttribute("data-canvas-transform-layer") === "true");
        assert.ok(transformLayer, "transform layer should be addressable");
        const liveK = Number(transformLayer.style.transform.match(/scale\(([^)]+)\)/)?.[1] || 0);
        anchorsRef.push(worldAt(container.current, viewportRef.current, 600, 400));
        assert.equal(pageCommits, 0, `gestures must not commit React state before 150ms silence; got ${pageCommits}`);
        assert.equal(nodeRenders, 1, `child nodes must not re-render during wheel gesture; got ${nodeRenders}`);
        assert.deepEqual(
            [anchorsRef[1].x.toFixed(2), anchorsRef[1].y.toFixed(2)],
            [anchorsRef[0].x.toFixed(2), anchorsRef[0].y.toFixed(2)],
            "live viewport ref must preserve the mouse anchor during gesture",
        );
        assert.equal(scaleRef.current, liveK, "shared scale ref must track the live transform");
        assert.equal(liveK > 1, true, `transform should show immediate zoom; got ${liveK}`);

        const anchorAfter = worldAt(container.current, viewport, 600, 400);
        assert.deepEqual(
            [anchorAfter.x.toFixed(2), anchorAfter.y.toFixed(2)],
            [anchorBefore.x.toFixed(2), anchorBefore.y.toFixed(2)],
            "mouse anchor world point must not move",
        );
        assert.equal(Number(transformLayer.style.getPropertyValue("--canvas-inverse-scale")).toFixed(6), (1 / liveK).toFixed(6));

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 170));
        });
        assert.equal(pageCommits, 1, `a silent wheel gesture must commit exactly once; got ${pageCommits}`);
        assert.equal(nodeRenders, 1, `child nodes must not re-render after committed viewport changes; got ${nodeRenders}`);
        assert.ok(viewport.k > 1);
        await act(async () => root.unmount());
    } finally {
        restoreDom(context);
    }
});

test("pan gestures update transform without React commits and commit on pointerup", async () => {
    const context = setupDom();
    try {
        const root = createRoot(context.dom.window.document.getElementById("root"));
        let commits = 0;
        const viewportRef = { current: { x: 0, y: 0, k: 1 } };
        const scaleRef = { current: 1 };
        const setViewport = () => {
            commits += 1;
        };
        const container = { current: null };
        await act(async () => {
            root.render(
                React.createElement(
                    InfiniteCanvas,
                    { containerRef: container, viewport: { x: 0, y: 0, k: 1 }, viewportRef, scaleRef, tool: "pan", onViewportChange: setViewport },
                    null,
                ),
            );
        });
        container.current.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800 });
        container.current.setPointerCapture = () => {};
        const view = context.dom.window;

        await act(async () => {
            container.current.dispatchEvent(pointerEvent(view, "pointerdown", 100, 100));
        });
        for (let index = 1; index <= 20; index += 1) {
            await act(async () => {
                context.dom.window.document.dispatchEvent(pointerEvent(view, "pointermove", 100 + index, 120 + index));
                await new Promise((resolve) => setTimeout(resolve, 1));
            });
        }
        const transformLayer = [...container.current.children].find((child) => child.getAttribute("data-canvas-transform-layer") === "true");
        assert.equal(commits, 0, `pan must not commit React state during movement; got ${commits}`);
        assert.match(transformLayer.style.transform, /translate\(20px, 40px\)/);

        await act(async () => {
            context.dom.window.dispatchEvent(pointerEvent(view, "pointerup", 120, 140, { buttons: 0 }));
        });
        assert.equal(commits, 1, `pan must commit once on pointerup; got ${commits}`);
        await act(async () => root.unmount());
    } finally {
        restoreDom(context);
    }
});
