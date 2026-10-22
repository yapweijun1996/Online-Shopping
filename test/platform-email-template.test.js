import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sellerEmailTemplate } from '../public/platform/email-template.js';

test('seller email carries the sign-in details and tells the seller to change the password first', () => {
  const mail = sellerEmailTemplate({ shopName: 'Demo Mart', sellerUrl: 'https://seller.example.test/seller/', username: 'seller', password: 'Temp-pass_123' });
  assert.equal(mail.subject, 'Your Demo Mart seller account');
  for (const line of ['Seller page: https://seller.example.test/seller/', 'Username: seller', 'Temporary password: Temp-pass_123']) assert.ok(mail.body.includes(line), line);
  assert.match(mail.body, /choose a new password straight away/);
  assert.equal(mail.text, `Subject: ${mail.subject}\n\n${mail.body}`);
});
