import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const assetPicker = readFileSync(new URL("./asset-picker-modal.tsx", import.meta.url), "utf8");

test("素材库筛选使用现有分类和标签接口并隔离查询缓存", () => {
    assert.match(assetPicker, /const \[category, setCategory\] = useState\(""\)/);
    assert.match(assetPicker, /const \[selectedTags, setSelectedTags\] = useState<string\[\]>\(\[\]\)/);
    assert.match(assetPicker, /queryKey: \["asset-picker-library", keyword, kindFilter, category, selectedTags, page\]/);
    assert.match(assetPicker, /fetchAssetLibrary\(\{ keyword, type: kindFilter, category, tag: selectedTags, page, pageSize: PAGE_SIZE \}\)/);
    assert.match(assetPicker, /const categories = query\.data\?\.categories \|\| \[\]/);
    assert.match(assetPicker, /const tags = query\.data\?\.tags \|\| \[\]/);
});

test("我的素材按分类精确匹配，标签使用 OR 语义", () => {
    assert.match(assetPicker, /const categories = useMemo\(\(\) => Array\.from\(new Set\(assets\.flatMap\(\(asset\) => \(asset\.category \? \[asset\.category\] : \[\]\)\)\)\), \[assets\]\)/);
    assert.match(assetPicker, /const tags = useMemo\(\(\) => Array\.from\(new Set\(assets\.flatMap\(\(asset\) => asset\.tags \|\| \[\]\)\)\)\.filter\(Boolean\), \[assets\]\)/);
    assert.match(assetPicker, /\.filter\(\(a\) => !category \|\| a\.category === category\)/);
    assert.match(assetPicker, /\.filter\(\(a\) => !selectedTags\.length \|\| selectedTags\.some\(\(tag\) => \(a\.tags \|\| \[\]\)\.includes\(tag\)\)\)/);
    assert.match(assetPicker, /\}, \[assets, keyword, kindFilter, category, selectedTags\]\)/);
});

test("两个素材页签的筛选变化都会重置分页", () => {
    const callbacks = [...assetPicker.matchAll(/onCategoryChange=\{\(value\) => \{ setPage\(1\); setCategory\(value\); \}\} onTagsChange=\{\(values\) => \{ setPage\(1\); setSelectedTags\(values\); \}\}/g)];
    assert.equal(callbacks.length, 2);
    assert.match(assetPicker, /function AssetFilters\(/);
    assert.match(assetPicker, /\["", \.\.\.categories\]\.map/);
    assert.match(assetPicker, /tags\.map\(\(tag\) =>/);
    assert.match(assetPicker, /onChange=\{\(\) => onTagsChange\(\[\]\)\}/);
});
