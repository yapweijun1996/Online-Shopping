# Shop logo

A shop owner can upload or remove the shop logo in seller Settings. The storefront displays the Pomelo compact logo when no custom image is available. PNG, JPEG and WebP signatures are accepted, up to 256 KiB.

`PUT /api/v1/seller/shop-logo` accepts the raw image bytes; `DELETE` removes the image. Both require an authenticated account with `settings.write`, the seller origin and CSRF token. Changes are recorded in `shop_logo_event` in the shop database. `GET /api/v1/shop/logo` returns the current image with an ETag and revalidation headers, or 404 when no logo is set.

Seller Settings accepts PNG, JPEG and WebP files up to 8 MiB and prepares them locally before upload. Images are resized to fit within 512 pixels; transparency is retained in PNG, while opaque images use WebP or JPEG compression. The browser targets 250 KiB and reports an error if the image cannot be prepared. The server continues to enforce its existing 256 KiB signature-checked limit.
