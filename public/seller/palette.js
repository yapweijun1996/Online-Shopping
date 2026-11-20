import { storageKey } from '../shared/storage-scope.js';
import { mountPalettePreference } from '../shared/palette-registry.js';

window.sellerPalette = mountPalettePreference('seller', storageKey('online-shopping-seller-palette-v1'));
