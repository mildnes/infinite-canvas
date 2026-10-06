import assert from "node:assert/strict";
import test from "node:test";

import { stripReferenceMetadata } from "./prompt-reference-metadata.ts";

test("图片N（用户本轮图片M，文件名）还原为 图片N", () => {
    const input = "仅局部编辑图片1（用户本轮图片237，CZ场景 1.png）。图片1是唯一场景布局、车阵排布。";
    assert.equal(stripReferenceMetadata(input), "仅局部编辑图片1。图片1是唯一场景布局、车阵排布。");
});

test("多参考职责列表删除明确文件名，保留无法确认的无点号字符串", () => {
    const input = "参考车辆与职责：图片2（用户图片114，7.jpg）、图片3（用户图片160，5860fab8…jpg）、图片4（用户图片217，追光45.png）分别是四款替换车辆的唯一车型身份参考。";
    assert.equal(
        stripReferenceMetadata(input),
        "参考车辆与职责：图片2、图片3（5860fab8…jpg）、图片4分别是四款替换车辆的唯一车型身份参考。",
    );
});

test("不带文件名的溯源标注同样还原", () => {
    assert.equal(stripReferenceMetadata("图片5（用户图片229）是唯一参考。"), "图片5是唯一参考。");
    assert.equal(stripReferenceMetadata("图片1（用户本轮图片237）保持不变。"), "图片1保持不变。");
});

test("职责说明不被误删", () => {
    const input = "图片1（唯一场景基准）、图片2（左侧 Logo 唯一原件）、图片3（透明亚克力背板）。";
    assert.equal(stripReferenceMetadata(input), input);
});

test("独立的（用户本轮图片M，文件名）片段被删除", () => {
    assert.equal(stripReferenceMetadata("参考（用户图片114，7.jpg）中的车型。"), "参考中的车型。");
    assert.equal(stripReferenceMetadata("以（用户本轮图片237，CZ场景 1.png）为基准。"), "以为基准。");
});

test("普通文本与空值安全", () => {
    assert.equal(stripReferenceMetadata("图片1是唯一场景基准。"), "图片1是唯一场景基准。");
    assert.equal(stripReferenceMetadata(""), "");
});

const fixtures = [
    ["嵌套文件名", "图片1（用户图片114，场景(终版).png）", "图片1"],
    ["职责与文件名混合", "图片2（用户图片114，左侧 Logo 唯一原件，7.jpg）", "图片2（左侧 Logo 唯一原件）"],
    ["职责字段含逗号", "图片2（用户图片114，左侧 Logo，唯一原件，7.jpg）", "图片2（左侧 Logo，唯一原件）"],
    ["多处嵌套标注", "图片1（用户图片114，场景(终版).png）、图片2（用户图片115，x(y).jpg）分别是参考。", "图片1、图片2分别是参考。"],
    ["半角括号与嵌套职责", "图片1(用户图片4;左侧(Logo,车标);final.PNG)", "图片1(左侧(Logo,车标))"],
    ["视频构造样本", "视频1（用户视频9，demo(1).mp4）", "视频1"],
    ["音频构造样本", "音频1（用户本轮音频9，朗读，demo(1).wav）", "音频1（朗读）"],
    ["职责标注原样", "图片2（左侧 Logo 唯一原件）保持不变。", "图片2（左侧 Logo 唯一原件）保持不变。"],
    ["独立空括号删除", "参考（用户图片114，7.jpg）中的车型", "参考中的车型"],
    ["不完整括号", "图片1（用户图片114（括号不完整）", "图片1（用户图片114（括号不完整）"],
    ["括号不匹配", "图片1（用户图片114，x.png)", "图片1（用户图片114，x.png)"],
    ["未知扩展名", "图片1（用户图片114，scene.psd）", "图片1（用户图片114，scene.psd）"],
    ["普通文件名不主动删", "图片1（Logo.png）", "图片1（Logo.png）"],
    ["非明确溯源编号", "图片1（用户图片114号，7.jpg）", "图片1（用户图片114号，7.jpg）"],
    ["保留职责分隔符", "图片1（用户图片114；左侧Logo,唯一原件；7.jpg）", "图片1（左侧Logo,唯一原件）"],
];
for (const [name, input, expected] of fixtures) {
    test(`${name}：保守清洗并保持幂等`, () => {
        assert.equal(stripReferenceMetadata(input), expected);
        assert.equal(stripReferenceMetadata(expected), expected);
    });
}

test("固定媒体扩展名白名单全部支持，忽略大小写", () => {
    for (const ext of "png/apng/jpg/jpeg/jfif/webp/gif/avif/bmp/tif/tiff/heic/heif/svg/mp4/m4v/mov/webm/mkv/avi/3gp/mp3/wav/m4a/aac/flac/ogg/opus/aiff/wma/amr".split("/")) {
        assert.equal(stripReferenceMetadata(`图片1（用户图片2，场景(终版).${ext.toUpperCase()}）`), "图片1");
    }
});
