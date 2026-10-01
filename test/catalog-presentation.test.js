import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryIconPath, formatCatalogPrice } from '../public/shop/catalog-presentation.js';
test('catalog MYR display is RM with exact localized minor-unit amounts',()=>{
 for(const locale of ['en','ms','zh-Hans','vi','th','ja','ko']){
  const expected=new Intl.NumberFormat(locale,{minimumFractionDigits:2,maximumFractionDigits:2}).format(12345.67);
  assert.equal(formatCatalogPrice(1234567,'MYR',locale),'RM\u00a0'+expected);
 }
 assert.equal(formatCatalogPrice(0,'MYR','en'),'RM\u00a00.00');
 assert.throws(()=>formatCatalogPrice(-1,'MYR'),RangeError);
 assert.throws(()=>formatCatalogPrice(1.2,'MYR'),RangeError);
 assert.match(formatCatalogPrice(1234,'SGD','en'),/12\.34/);
});
test('semantic category icons support actual and non-pet categories with safe neutral fallback',()=>{
 const fallback=categoryIconPath('');
 for(const category of ['Cat Litter','Waste Bags','Electronics','Books','Home','Clothing'])assert.notEqual(categoryIconPath(category),fallback);
 assert.equal(categoryIconPath('Unknown <script>'),fallback);
 assert.equal(categoryIconPath('Litter Box Accessories'),categoryIconPath('Tools'));
});
