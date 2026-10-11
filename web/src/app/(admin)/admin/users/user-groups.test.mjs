import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import axios from "axios";
import { saveAdminUser } from "@/services/api/admin";

test("用户保存 transport 保留 groupId 空值，允许 VIP 移回默认组", async () => {
    const original = axios.request;
    let request;
    axios.request = async config => { request = config; return { status: 200, data: { code: 0, data: config.data } }; };
    try {
        const result = await saveAdminUser("token", { id: "u", groupId: "", groupOnly: true });
        assert.equal(request.url, "/api/admin/users");
        assert.equal(request.headers.Authorization, "Bearer token");
        assert.equal(result.groupId, "");
        assert.equal(result.groupOnly, true);
        assert.equal(result.username, undefined);
    } finally { axios.request = original; }
});

test("真实批量归组回调仅发 id/groupId，单个失败不会覆盖其他用户或中断后续", async () => {
    const source = readFileSync(new URL("./use-admin-users.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("users.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let object;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "groupMutation") object = node.initializer.arguments[0];
        ts.forEachChild(node, visit);
    }
    visit(ast);
    const fn = object.properties.find(node => node.name?.getText(ast) === "mutationFn").initializer.getText(ast);
    const requests = [];
    const context = { token: "t", saveAdminUser: async (token, data) => { requests.push({ token, data }); if (data.id === "bad") throw new Error("fixture"); } };
    const run = vm.runInNewContext(ts.transpileModule("const run = " + fn + "; run;", { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
    await assert.rejects(run({ ids: ["a", "bad", "b"], groupId: "vip" }), /1 个用户/);
    assert.deepEqual(requests.map(({ data }) => ({ ...data })), ["a", "bad", "b"].map(id => ({ id, groupId: "vip", groupOnly: true })));
});
