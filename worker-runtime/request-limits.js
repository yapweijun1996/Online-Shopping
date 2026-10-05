// Ten 512 KiB images expand to about seven MB as base64 JSON. The API and
// Worker gallery ingress share this byte budget so neither silently truncates it.
export const PRODUCT_MUTATION_BODY_LIMIT = 7_500_000;
