import { storageKey } from '../shared/storage-scope.js';
import { mountPalettePreference } from '../shared/palette-registry.js';

window.shopPalette = mountPalettePreference('shop', storageKey('online-shopping-shop-palette-v1'));
