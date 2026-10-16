/* 邮人全搜界面语言回归测试：验证中文默认值、多语言翻译和双语模式。 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadI18n() {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "ui-i18n.js"), "utf8"), context);
  return context.ByrUiI18n;
}

test("界面语言字典保留中文默认值并支持多语言和双语模式", () => {
  const i18n = loadI18n();
  assert.equal(i18n.translate("搜索", "zh-CN"), "搜索");
  assert.equal(i18n.translate("搜索", "en"), "Search");
  assert.equal(i18n.translate("搜索", "ja"), "検索");
  assert.equal(i18n.translate("搜索", "ko"), "검색");
  assert.equal(i18n.translate("搜索", "ru"), "Поиск");
  assert.equal(i18n.translate("搜索", "zh-en"), "搜索 / Search");
});
