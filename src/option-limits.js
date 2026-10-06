/*
 * Limits for product options. They bound storage and the generated combinations and are kept in one
 * place so a tenant-level setting can replace them later; no option name or type is predefined.
 */
export const OPTION_LIMITS = Object.freeze({
  typesPerGroup: 6,        // option types combined in one product group (for example colour x storage)
  valuesPerType: 200,      // values a tenant can define for one option type
  combinationsPerGroup: 300, // products (SKUs) in one variant group
  translationLocales: 20,
});
