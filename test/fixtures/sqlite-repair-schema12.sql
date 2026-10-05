-- Actual repair-branch schema12; fictional fixture generated with its runtime.
PRAGMA foreign_keys=OFF;
CREATE TABLE admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE order_sequence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL CHECK (value >= 0)
      ) STRICT;
CREATE TABLE delivery (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        recipient_name TEXT NOT NULL,
        recipient_phone TEXT NOT NULL,
        address_line1 TEXT NOT NULL,
        address_line2 TEXT,
        address_city TEXT,
        address_region TEXT,
        address_postcode TEXT NOT NULL,
        address_country TEXT NOT NULL,
        UNIQUE(order_id, position)
      ) STRICT;
CREATE TABLE order_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES shop_order(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (event_type IN ('SUBMITTED', 'CONFIRMED', 'REJECTED')),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('GUEST', 'SELLER')),
        actor_id TEXT,
        previous_status TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        occurred_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE checkout_idempotency (
        key_hash TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE REFERENCES shop_order(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      ) STRICT;
CREATE TABLE general_code (
        type TEXT NOT NULL CHECK (type = 'PRODUCT_CATEGORY'),
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (type, code),
        UNIQUE (type, label)
      ) STRICT;
CREATE TABLE "product" (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000),
        currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        translations_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(translations_json)),
        image_mime TEXT,
        image_data BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, variant_group TEXT, variant_label TEXT, gallery_layout_json TEXT
        CHECK (gallery_layout_json IS NULL OR (json_valid(gallery_layout_json) AND json_type(gallery_layout_json) = 'array')),
        CHECK ((image_mime IS NULL AND image_data IS NULL) OR
               (image_mime IN ('image/png', 'image/jpeg', 'image/webp') AND image_data IS NOT NULL))
      ) STRICT;
CREATE TABLE "shop_order" (
        id TEXT PRIMARY KEY,
        order_no TEXT NOT NULL UNIQUE,
        buyer_name TEXT NOT NULL,
        buyer_phone TEXT NOT NULL,
        buyer_email TEXT,
        whatsapp_opt_in INTEGER NOT NULL CHECK (whatsapp_opt_in IN (0, 1)),
        whatsapp_consent_at TEXT,
        whatsapp_consent_version TEXT,
        locale TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REJECTED')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
        total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((whatsapp_opt_in = 0 AND whatsapp_consent_at IS NULL AND whatsapp_consent_version IS NULL) OR
               (whatsapp_opt_in = 1 AND whatsapp_consent_at IS NOT NULL AND whatsapp_consent_version IS NOT NULL))
      ) STRICT;
CREATE TABLE "order_item" (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES delivery(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        sku_snapshot TEXT NOT NULL,
        name_snapshot TEXT NOT NULL,
        price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
        quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
        line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
        currency TEXT NOT NULL CHECK (currency IN ('MYR', 'SGD')),
        UNIQUE(delivery_id, position)
      ) STRICT;
CREATE TABLE company_setting (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          default_currency TEXT NOT NULL CHECK (default_currency IN ('MYR', 'SGD')),
          updated_at TEXT NOT NULL
        , seller_whatsapp_phone TEXT
        CHECK (seller_whatsapp_phone IS NULL OR
          (length(seller_whatsapp_phone) BETWEEN 8 AND 15 AND seller_whatsapp_phone NOT GLOB '*[^0-9]*')), mobile_hide_bars_on_scroll INTEGER NOT NULL DEFAULT 0
        CHECK (mobile_hide_bars_on_scroll IN (0, 1))) STRICT;
CREATE TABLE rate_limit_attempt (
        id INTEGER PRIMARY KEY,
        bucket TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        attempted_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE shop_setup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT CHECK (mode IN ('demo', 'production')),
        shop_name TEXT NOT NULL
      ) STRICT;
CREATE TABLE "product_gallery_image" (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
        mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
        data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(product_id, position)
      ) STRICT;
INSERT INTO admin (id,username,password_hash,created_at) VALUES (1,'synthetic','x:y','2026-10-06T00:00:00.000Z');
INSERT INTO order_sequence (id,value) VALUES (1,1);
INSERT INTO delivery (id,order_id,position,recipient_name,recipient_phone,address_line1,address_line2,address_city,address_region,address_postcode,address_country) VALUES ('1936494c-d4c4-475b-9758-5dc94feffa92','6aa299bd-63ce-4920-ae32-4083a08df6f4',0,'Fictional Recipient','+60123456789','Fictional Street',NULL,NULL,NULL,'47810','MY');
INSERT INTO order_event (id,order_id,event_type,actor_type,actor_id,previous_status,status,reason,occurred_at) VALUES (1,'6aa299bd-63ce-4920-ae32-4083a08df6f4','SUBMITTED','GUEST',NULL,NULL,'SUBMITTED',NULL,'2026-10-05T23:45:17.618Z');
INSERT INTO checkout_idempotency (key_hash,request_hash,order_id,created_at) VALUES ('bcf1d5c0c2f013ab6fa8fb5351f35d67d843095d4c9489ac2fa9b8ac037b02ff','dbf02a8f6e3555b5c2586f5a9505467cf9f44d7dc053daf4058c511594b6c878','6aa299bd-63ce-4920-ae32-4083a08df6f4','2026-10-05T23:45:17.618Z');
INSERT INTO general_code (type,code,label,active,created_at,updated_at) VALUES ('PRODUCT_CATEGORY','SYNTHETIC','Synthetic',1,'2026-10-05T23:45:17.612Z','2026-10-05T23:45:17.612Z');
INSERT INTO product (id,sku,name,description,category,price_minor,currency,active,translations_json,image_mime,image_data,created_at,updated_at,variant_group,variant_label,gallery_layout_json) VALUES ('28157122-d34b-4683-8e3c-234c1ffc5dd8','SYNTHETIC','Fictional preserved item','Historical fixture only','SYNTHETIC',1200,'MYR',1,'{}',NULL,NULL,'2026-10-05T23:45:17.614Z','2026-10-05T23:45:17.614Z',NULL,NULL,NULL);
INSERT INTO shop_order (id,order_no,buyer_name,buyer_phone,buyer_email,whatsapp_opt_in,whatsapp_consent_at,whatsapp_consent_version,locale,status,revision,currency,total_minor,submitted_at,updated_at) VALUES ('6aa299bd-63ce-4920-ae32-4083a08df6f4','OS-00000001','Fictional Buyer','','fixture@example.invalid',0,NULL,NULL,'en','SUBMITTED',1,'MYR',1200,'2026-10-05T23:45:17.618Z','2026-10-05T23:45:17.618Z');
INSERT INTO order_item (id,delivery_id,position,product_id,sku_snapshot,name_snapshot,price_minor,quantity,line_total_minor,currency) VALUES ('5fccff56-1ffb-4ebf-a1ec-a91b07067560','1936494c-d4c4-475b-9758-5dc94feffa92',0,'28157122-d34b-4683-8e3c-234c1ffc5dd8','SYNTHETIC','Fictional preserved item',1200,1,1200,'MYR');
INSERT INTO company_setting (id,default_currency,updated_at,seller_whatsapp_phone,mobile_hide_bars_on_scroll) VALUES (1,'MYR','2026-10-05 23:45:17',NULL,0);
INSERT INTO shop_setup (id,mode,shop_name) VALUES (1,NULL,'Online Shopping');
CREATE INDEX session_expiry ON session(expires_at);
CREATE INDEX order_event_history ON order_event(order_id, id);
CREATE INDEX product_public ON product(active, category, updated_at);
CREATE INDEX shop_order_queue ON shop_order(status, submitted_at DESC);
CREATE TRIGGER product_category_insert BEFORE INSERT ON product
          WHEN NOT EXISTS (SELECT 1 FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1)
          BEGIN SELECT RAISE(ABORT, 'Unknown active product category'); END;
CREATE TRIGGER product_category_update BEFORE UPDATE OF category ON product
          WHEN NEW.category <> OLD.category AND NOT EXISTS
            (SELECT 1 FROM general_code WHERE type = 'PRODUCT_CATEGORY' AND code = NEW.category AND active = 1)
          BEGIN SELECT RAISE(ABORT, 'Unknown active product category'); END;
CREATE INDEX rate_limit_lookup ON rate_limit_attempt(bucket, key_hash);
CREATE INDEX rate_limit_expiry ON rate_limit_attempt(bucket, attempted_at);
CREATE UNIQUE INDEX product_variant_option ON product(variant_group, variant_label COLLATE NOCASE);
CREATE INDEX product_variant_group ON product(variant_group, active);
CREATE INDEX product_gallery_product ON product_gallery_image(product_id, position);
PRAGMA user_version=12;
PRAGMA foreign_keys=ON;
