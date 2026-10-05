import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { postgresSchema12Sql, postgresUpgradeTo12Sql } from '../src/postgres-schema-compatibility.js';

// Emit reviewable synthetic SQL only. No connection, server, credentials,
// migration, backup or restore is executed by this preparation script.
const out = resolve(process.env.QA_OUTPUT_DIR || 'output/repair/postgres-proof');
mkdirSync(out, { recursive: true, mode: 0o700 });
const write = (name, sql) => writeFileSync(resolve(out, name), sql, { mode: 0o600 });
write('01-historical-schema10.sql', readFileSync(new URL('../test/fixtures/postgres-schema10.sql', import.meta.url), 'utf8'));
write('02-seed.sql', `
INSERT INTO general_code VALUES ('PRODUCT_CATEGORY','SYNTHETIC','Synthetic',1,'synthetic-time','synthetic-time');
INSERT INTO product(id,sku,name,description,category,price_minor,currency,active,created_at,updated_at)
  VALUES ('synthetic-product','SYNTHETIC-001','Synthetic product','','SYNTHETIC',900,'SGD',1,'synthetic-time','synthetic-time');
INSERT INTO product_gallery_image VALUES ('synthetic-image','synthetic-product',4,'image/png',decode('89504e4700010203','hex'),'synthetic-time');
INSERT INTO shop_order(id,order_no,buyer_name,buyer_phone,whatsapp_opt_in,locale,status,revision,currency,total_minor,submitted_at,updated_at)
  VALUES ('synthetic-order','SYNTHETIC-ORDER','Synthetic Buyer','',0,'en','SUBMITTED',1,'SGD',1800,'synthetic-time','synthetic-time');
INSERT INTO delivery(id,order_id,position,recipient_name,recipient_phone,address_line1,address_postcode,address_country)
  VALUES ('synthetic-delivery','synthetic-order',0,'Synthetic Recipient','','Synthetic Street','00000','MY');
INSERT INTO order_item VALUES ('synthetic-item','synthetic-delivery',0,'synthetic-product','SYNTHETIC-001','Synthetic product',900,2,1800,'SGD');
INSERT INTO order_event(order_id,event_type,actor_type,status,occurred_at)
  VALUES ('synthetic-order','SUBMITTED','GUEST','SUBMITTED','synthetic-time');
INSERT INTO checkout_idempotency VALUES ('synthetic-key-hash','synthetic-request-hash','synthetic-order','synthetic-time');
`);
for (const version of [10, 11]) write(`upgrade-${version}-to12.sql`, `BEGIN;\nSELECT pg_advisory_xact_lock(1095978835);\n${postgresUpgradeTo12Sql(version)}\nCOMMIT;\n`);
write('fresh-schema12.sql', `BEGIN;\n${postgresSchema12Sql}\nCOMMIT;\n`);
write('assert-preservation.sql', `DO $$ BEGIN
  IF (SELECT version FROM schema_meta WHERE id=1) <> 12 THEN RAISE EXCEPTION 'Version not12'; END IF;
  IF (SELECT COUNT(*) FROM product WHERE id='synthetic-product' AND price_minor=900 AND currency='SGD' AND gallery_layout_json IS NULL) <> 1 THEN RAISE EXCEPTION 'Product changed'; END IF;
  IF (SELECT COUNT(*) FROM product_gallery_image WHERE id='synthetic-image' AND product_id='synthetic-product' AND position=4 AND mime='image/png' AND encode(data,'hex')='89504e4700010203' AND created_at='synthetic-time') <> 1 THEN RAISE EXCEPTION 'Image changed'; END IF;
  IF (SELECT COUNT(*) FROM order_item WHERE id='synthetic-item' AND price_minor=900 AND quantity=2 AND line_total_minor=1800 AND currency='SGD') <> 1 THEN RAISE EXCEPTION 'Snapshot changed'; END IF;
  IF (SELECT COUNT(*) FROM shop_order WHERE id='synthetic-order' AND total_minor=1800 AND currency='SGD' AND revision=1) <> 1 THEN RAISE EXCEPTION 'Order changed'; END IF;
  IF (SELECT COUNT(*) FROM order_event WHERE order_id='synthetic-order') <> 1 OR (SELECT COUNT(*) FROM checkout_idempotency WHERE order_id='synthetic-order') <> 1 THEN RAISE EXCEPTION 'History changed'; END IF;
  IF (SELECT default_currency FROM company_setting WHERE id=1) <> 'MYR' THEN RAISE EXCEPTION 'Company currency changed'; END IF;
END $$;\n`);
write('assert-negative-constraints.sql', `DO $$ BEGIN
  BEGIN
    INSERT INTO product_gallery_image VALUES ('synthetic-position11','synthetic-product',11,'image/png',decode('00','hex'),'synthetic-time');
    RAISE EXCEPTION 'Position11 accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE product SET gallery_layout_json='{}' WHERE id='synthetic-product';
    RAISE EXCEPTION 'Object layout accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE product SET gallery_layout_json='malformed' WHERE id='synthetic-product';
    RAISE EXCEPTION 'Malformed layout accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL; END;
END $$;\n`);
write('interrupted-upgrade.sql', `BEGIN;\n${postgresUpgradeTo12Sql(10).replace('UPDATE schema_meta SET version', "SELECT 1/0;\nUPDATE schema_meta SET version")}\nCOMMIT;\n`);
write('README.md', `# Prepared PostgreSQL engine and restore proof

These files have not been executed against PostgreSQL. Preparation does not establish
SQL, native-store, HTTP/API, migration or recovery PASS. Use only a newly created private
synthetic database on an independently authorized PostgreSQL16 fixture.

1. Apply historical schema10 and seed using psql -X -v ON_ERROR_STOP=1; capture table
   counts and complete row/image-byte hashes. Take a custom pg_dump backup and record
   its SHA256. The image fixture tests byte preservation, not a decoded PNG.
2. Apply interrupted-upgrade.sql with ON_ERROR_STOP. It must fail; disconnecting the
   failed transaction must retain version10, no layout column and all original data.
3. Apply upgrade-10-to12.sql, then preservation and negative-constraint assertions;
   compare all original table rows/hashes. Test concurrent initializer sessions too.
4. Restore the pre-upgrade dump with pg_restore into a separate empty synthetic database,
   upgrade that copy and repeat preservation assertions. Never restore over newer writes.
5. Repeat with an independently constructed known schema11 fixture and fresh schema12;
   reject unknown/nonempty databases. Exercise the original native store/worker/API.

The current application's startup does not import this compatibility module. Existing
schema upgrades require explicit allowUpgrade=true and separate exact-artifact review.
The local PostgreSQL initialization attempt was blocked by shmget EPERM; no alternative
server configuration, runtime or permissions were used to bypass it.
`);
console.log(JSON.stringify({ directory: out, status: 'PREPARED_NOT_EXECUTED' }));
