import assert from "node:assert/strict";
import test from "node:test";

import { canvasFixture, project, tick } from "./test-utils/canvas-store-fixture.mjs";

const baseline = process.env.CANVAS_TAKEOVER_BASELINE;

function localProject(id, title = "本地副本") {
    return {
        ...project(id),
        title,
        nodes: [project(`${id}-first`).nodes[0], project(`${id}-second`).nodes[0]],
        hydrated: true,
    };
}

function summary(id) {
    return {
        ...project(id),
        hydrated: false,
        nodes: [],
        connections: [],
        chatSessions: [],
        nodeCount: 2,
        connectionCount: 0,
        sessionCount: 1,
    };
}

async function readyFixture(options) {
    const fixture = canvasFixture({ ...options, baseline });
    await tick();
    fixture.clearOperations();
    return fixture;
}

test("接管关闭云同步的账号画板时读取本地完整副本且不请求云端", async () => {
    const local = localProject("board", "本地新建");
    const fixture = await readyFixture({
        owner: "A",
        projects: [local],
        remote: [],
        syncEnabled: false,
    });

    const loaded = await fixture.useCanvasStore.getState().loadProject("board", true);

    assert.equal(loaded?.title, "本地新建");
    assert.equal(loaded?.nodes.length, 2);
    assert.equal(fixture.requests.filter(([kind]) => kind === "get").length, 0);
});

test("开启云同步但云端记录不存在时回落到本地完整副本", async () => {
    const local = localProject("board", "仅本地");
    const fixture = await readyFixture({
        owner: "A",
        projects: [local],
        remote: [],
        syncEnabled: true,
    });
    fixture.detailGate(Promise.resolve(undefined));

    const loaded = await fixture.useCanvasStore.getState().loadProject("board", true);

    assert.equal(loaded?.title, "仅本地");
    assert.equal(loaded?.nodes.length, 2);
    assert.equal(fixture.requests.filter(([kind]) => kind === "get").length, 1);
});

test("开启云同步且云端有更新时仍以云端完整画板为准", async () => {
    const local = localProject("board", "旧本地");
    const remote = localProject("board", "云端最新");
    const fixture = await readyFixture({
        owner: "A",
        projects: [local],
        remote: [remote],
        syncEnabled: true,
    });
    fixture.detailGate(Promise.resolve({
        ...remote,
        updatedAt: "2027-01-01T00:00:00Z",
    }));

    const loaded = await fixture.useCanvasStore.getState().loadProject("board", true);

    assert.equal(loaded?.title, "云端最新");
    assert.equal(loaded?.updatedAt, "2027-01-01T00:00:00Z");
});

test("云端记录不存在且本地也没有完整副本时仍报错", async () => {
    const fixture = await readyFixture({
        owner: "A",
        projects: [summary("board")],
        remote: [],
        syncEnabled: true,
    });
    fixture.detailGate(Promise.resolve(undefined));

    await assert.rejects(
        fixture.useCanvasStore.getState().loadProject("board", true),
        /画布数据不完整/,
    );
});
