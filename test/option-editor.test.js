import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { combinations, skuFor } from '../public/seller/options.js';
import { messages } from '../public/shared/i18n.js';

const type = (id, name) => ({ id, name });
const value = (id, label) => ({ id, label });

test('combinations are the cartesian product in option order', () => {
  const colour = type('c', 'Colour'), storage = type('s', 'Storage');
  const rows = combinations([{ type: colour, values: [value('r', 'Red'), value('b', 'Blue')] }, { type: storage, values: [value('1', '256'), value('2', '512')] }]);
  assert.deepEqual(rows.map(row => row.map(({ value }) => value.label).join(' / ')), ['Red / 256', 'Red / 512', 'Blue / 256', 'Blue / 512']);
  assert.deepEqual(rows[0].map(({ type }) => type.id), ['c', 's']);
  assert.equal(combinations([{ type: colour, values: [value('r', 'Red')] }]).length, 1);
  assert.deepEqual(combinations([]), [], 'nothing chosen means no rows');
});

test('generated SKUs use the prefix and a three-digit sequence', () => {
  assert.equal(skuFor('px', 0), 'PX-001');
  assert.equal(skuFor('Phone-x', 11), 'PHONE-X-012');
});

test('every seller option string exists in all seven languages', () => {
  const keys = ['optionsNav', 'optionsIntro', 'optionTypesTitle', 'optionTypeName', 'optionDisplay', 'displayButton', 'displaySwatch', 'displayImage', 'displayDropdown',
    'addOptionType', 'optionValuesTitle', 'optionValueLabel', 'optionUseColor', 'optionOrder', 'addOptionValue', 'saveOptionItem', 'optionTranslations',
    'optionTranslationsHelp', 'optionSaved', 'optionDuplicate', 'optionError', 'optionsEmpty', 'generatorTitle', 'generatorIntro', 'generatorBaseTitle',
    'generatorSkuPrefix', 'generatorPickValues', 'generatorRows', 'generatorCombination', 'generatorInclude', 'generatorSubmit', 'generatorCreating',
    'generatorDone', 'generatorFailed', 'generatorNeedValues', 'generatorTooMany', 'productOptionsTitle', 'productOptionsHelp', 'optionNotSet',
    'optionsGroupNeeded', 'optionsSameTypes', 'optionsDuplicate', 'optionsRequired', 'optionChangesOthers', 'inStockLabel'];
  for (const [code, strings] of Object.entries(messages)) for (const key of keys) assert.ok(strings[key]?.trim(), `${code}.${key}`);
  for (const code of ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko']) {
    assert.match(messages[code].generatorDone, /\{created\}/); assert.match(messages[code].generatorDone, /\{total\}/);
    assert.match(messages[code].generatorTooMany, /\{max\}/); assert.match(messages[code].generatorFailed, /\{list\}/);
  }
});

test('the editor is reachable from the seller navigation and cached offline', () => {
  const html = readFileSync(new URL('../public/seller/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="options"/);
  assert.match(html, /id="product-options-fields"/);
  const app = readFileSync(new URL('../public/seller/app.js', import.meta.url), 'utf8');
  assert.match(app, /VALID_VIEWS = new Set\(\[[^\]]*'options'/);
  const worker = readFileSync(new URL('../public/seller/sw.js', import.meta.url), 'utf8');
  assert.match(worker, /\.\/options\.js/); assert.match(worker, /\.\/product-fields\.js/);
});

test('phone layout: combination cells carry captions and tap areas stay 44px', () => {
  const script = readFileSync(new URL('../public/seller/options.js', import.meta.url), 'utf8');
  assert.match(script, /cell\.dataset\.label/);
  assert.match(script, /'tap-box'/);
  const css = readFileSync(new URL('../public/seller/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.generator-table td::before\{content:attr\(data-label\)/);
  assert.match(css, /\.settings-form \.tap-box\{[^}]*min-width:44px/);
});

