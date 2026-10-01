// ../../../../../../../private/tmp/shop-printform-source/src/printform/helpers.js
var TRUE_TOKENS = /* @__PURE__ */ new Set(["y", "yes", "true", "1"]);
var FALSE_TOKENS = /* @__PURE__ */ new Set(["n", "no", "false", "0"]);
function parseBooleanFlag(value, fallback) {
  if (value === void 0 || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const lowered = String(value).trim().toLowerCase();
  if (TRUE_TOKENS.has(lowered)) return true;
  if (FALSE_TOKENS.has(lowered)) return false;
  return fallback;
}
function parseNumber(value, fallback) {
  if (value === void 0 || value === null || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}
function parseString(value, fallback) {
  if (value === void 0 || value === null || value === "") return fallback;
  return String(value);
}
function normalizeOrientation(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "landscape") return "landscape";
  if (token === "portrait") return "portrait";
  return "";
}
function normalizePaperSize(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  const upper = token.toUpperCase();
  if (upper === "A4" || upper === "A5" || upper === "LETTER" || upper === "LEGAL") {
    return upper;
  }
  if (upper === "US_LETTER" || upper === "USLETTER") return "LETTER";
  if (upper === "US_LEGAL" || upper === "USLEGAL") return "LEGAL";
  return "";
}
function mmToPx(mm, dpi) {
  const mmValue = Number(mm);
  const dpiValue = Number(dpi);
  if (!Number.isFinite(mmValue) || !Number.isFinite(dpiValue) || dpiValue <= 0) return 0;
  return Math.round(mmValue / 25.4 * dpiValue);
}
var PAPER_SIZES_MM = {
  A4: { widthMm: 210, heightMm: 297 },
  A5: { widthMm: 148, heightMm: 210 },
  LETTER: { widthMm: 215.9, heightMm: 279.4 },
  LEGAL: { widthMm: 215.9, heightMm: 355.6 }
};
function resolvePaperDimensions(options) {
  const paperSize = normalizePaperSize(options && options.paperSize);
  if (!paperSize) return null;
  const preset = PAPER_SIZES_MM[paperSize];
  if (!preset) return null;
  const dpi = Number(options && options.dpi);
  const width = mmToPx(preset.widthMm, dpi);
  const height = mmToPx(preset.heightMm, dpi);
  if (!width || !height) return null;
  const orientation = normalizeOrientation(options && options.orientation) || "portrait";
  if (orientation === "landscape") {
    return { width: height, height: width };
  }
  return { width, height };
}
function normalizeHeight(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const epsilon = 1e-6;
  return Math.max(0, Math.ceil(num - epsilon));
}
function ensurePageNumberPlaceholder(element) {
  if (!element) return null;
  if (element.__pageNumberPlaceholder) {
    return element.__pageNumberPlaceholder;
  }
  const doc = element.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc) return null;
  let container = element.querySelector("[data-page-number-container]");
  if (!container) {
    container = element.querySelector("td:last-child") || element.querySelector("td") || element;
  }
  const placeholder = doc.createElement("span");
  placeholder.className = "printform_page_number_placeholder";
  container.appendChild(placeholder);
  element.__pageNumberPlaceholder = placeholder;
  return placeholder;
}
function ensurePhysicalPageNumberPlaceholder(element) {
  if (!element) return null;
  if (element.__physicalPageNumberPlaceholder) {
    return element.__physicalPageNumberPlaceholder;
  }
  const doc = element.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc) return null;
  let container = element.querySelector("[data-physical-page-number-container]");
  if (!container) {
    container = element.querySelector("td:last-child") || element.querySelector("td") || element;
  }
  const placeholder = doc.createElement("span");
  placeholder.className = "printform_physical_page_number_placeholder";
  container.appendChild(placeholder);
  element.__physicalPageNumberPlaceholder = placeholder;
  return placeholder;
}
function updatePageNumberContent(element, pageNumber, totalPages) {
  if (!element) return;
  const numberTargets = element.querySelectorAll("[data-page-number]");
  if (numberTargets.length > 0) {
    numberTargets.forEach(function(target) {
      target.textContent = pageNumber;
    });
  }
  const totalTargets = element.querySelectorAll("[data-page-total]");
  const totalValue = totalPages !== void 0 && totalPages !== null ? totalPages : "";
  if (totalTargets.length > 0) {
    totalTargets.forEach(function(target) {
      target.textContent = totalValue;
    });
  }
  if (numberTargets.length === 0 && totalTargets.length === 0) {
    const fallback = ensurePageNumberPlaceholder(element);
    if (fallback) {
      fallback.textContent = totalPages !== void 0 && totalPages !== null ? "Page " + pageNumber + " of " + totalPages : "Page " + pageNumber;
    }
  }
}
function updatePhysicalPageNumberContent(element, pageNumber, totalPages) {
  if (!element) return;
  const numberTargets = element.querySelectorAll("[data-physical-page-number]");
  if (numberTargets.length > 0) {
    numberTargets.forEach(function(target) {
      target.textContent = pageNumber;
    });
  }
  const totalTargets = element.querySelectorAll("[data-physical-page-total]");
  const totalValue = totalPages !== void 0 && totalPages !== null ? totalPages : "";
  if (totalTargets.length > 0) {
    totalTargets.forEach(function(target) {
      target.textContent = totalValue;
    });
  }
  if (numberTargets.length === 0 && totalTargets.length === 0) {
    const fallback = ensurePhysicalPageNumberPlaceholder(element);
    if (fallback) {
      fallback.textContent = totalPages !== void 0 && totalPages !== null ? "Sheet " + pageNumber + " of " + totalPages : "Sheet " + pageNumber;
    }
  }
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/config.js
var CONFIG_DESCRIPTORS = [
  { key: "papersizeWidth", datasetKey: "papersizeWidth", legacyKey: "papersize_width", defaultValue: 750, parser: parseNumber },
  { key: "papersizeHeight", datasetKey: "papersizeHeight", legacyKey: "papersize_height", defaultValue: 1050, parser: parseNumber },
  { key: "paperSize", datasetKey: "paperSize", legacyKey: "paper_size", defaultValue: "", parser: parseString },
  { key: "orientation", datasetKey: "orientation", legacyKey: "orientation", defaultValue: "portrait", parser: parseString },
  { key: "dpi", datasetKey: "dpi", legacyKey: "dpi", defaultValue: 96, parser: parseNumber },
  { key: "nUp", datasetKey: "nUp", legacyKey: "n_up", defaultValue: 1, parser: parseNumber },
  {
    key: "showLogicalPageNumber",
    datasetKey: "showLogicalPageNumber",
    legacyKey: "show_logical_page_number",
    defaultValue: true,
    parser: parseBooleanFlag
  },
  {
    key: "showPhysicalPageNumber",
    datasetKey: "showPhysicalPageNumber",
    legacyKey: "show_physical_page_number",
    defaultValue: false,
    parser: parseBooleanFlag
  },
  {
    key: "heightOfDummyRowItem",
    datasetKey: "heightOfDummyRowItem",
    legacyKey: "height_of_dummy_row_item",
    defaultValue: 18,
    parser: parseNumber
  },
  { key: "repeatHeader", datasetKey: "repeatHeader", legacyKey: "repeat_header", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatDocinfo", datasetKey: "repeatDocinfo", legacyKey: "repeat_docinfo", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatDocinfo002", datasetKey: "repeatDocinfo002", legacyKey: "repeat_docinfo002", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatDocinfo003", datasetKey: "repeatDocinfo003", legacyKey: "repeat_docinfo003", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatDocinfo004", datasetKey: "repeatDocinfo004", legacyKey: "repeat_docinfo004", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatDocinfo005", datasetKey: "repeatDocinfo005", legacyKey: "repeat_docinfo005", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatRowheader", datasetKey: "repeatRowheader", legacyKey: "repeat_rowheader", defaultValue: true, parser: parseBooleanFlag },
  {
    key: "repeatPtacRowheader",
    datasetKey: "repeatPtacRowheader",
    legacyKey: "repeat_ptac_rowheader",
    defaultValue: true,
    parser: parseBooleanFlag
  },
  { key: "repeatFooter", datasetKey: "repeatFooter", legacyKey: "repeat_footer", defaultValue: false, parser: parseBooleanFlag },
  { key: "repeatFooter002", datasetKey: "repeatFooter002", legacyKey: "repeat_footer002", defaultValue: false, parser: parseBooleanFlag },
  { key: "repeatFooter003", datasetKey: "repeatFooter003", legacyKey: "repeat_footer003", defaultValue: false, parser: parseBooleanFlag },
  { key: "repeatFooter004", datasetKey: "repeatFooter004", legacyKey: "repeat_footer004", defaultValue: false, parser: parseBooleanFlag },
  { key: "repeatFooter005", datasetKey: "repeatFooter005", legacyKey: "repeat_footer005", defaultValue: false, parser: parseBooleanFlag },
  { key: "repeatFooterLogo", datasetKey: "repeatFooterLogo", legacyKey: "repeat_footer_logo", defaultValue: false, parser: parseBooleanFlag },
  { key: "repeatFooterPagenum", datasetKey: "repeatFooterPagenum", legacyKey: "repeat_footer_pagenum", defaultValue: false, parser: parseBooleanFlag },
  {
    key: "fillPageHeightAfterFooter",
    datasetKey: "fillPageHeightAfterFooter",
    legacyKey: "fill_page_height_after_footer",
    defaultValue: true,
    parser: parseBooleanFlag
  },
  {
    key: "insertDummyRowItemWhileFormatTable",
    datasetKey: "insertDummyRowItemWhileFormatTable",
    legacyKey: "insert_dummy_row_item_while_format_table",
    defaultValue: true,
    parser: parseBooleanFlag
  },
  {
    key: "insertPtacDummyRowItems",
    datasetKey: "insertPtacDummyRowItems",
    legacyKey: "insert_ptac_dummy_row_items",
    defaultValue: true,
    parser: parseBooleanFlag
  },
  {
    key: "insertDummyRowWhileFormatTable",
    datasetKey: "insertDummyRowWhileFormatTable",
    legacyKey: "insert_dummy_row_while_format_table",
    defaultValue: false,
    parser: parseBooleanFlag
  },
  {
    key: "insertFooterSpacerWhileFormatTable",
    datasetKey: "insertFooterSpacerWhileFormatTable",
    legacyKey: "insert_footer_spacer_while_format_table",
    defaultValue: true,
    parser: parseBooleanFlag
  },
  {
    key: "insertFooterSpacerWithDummyRowItemWhileFormatTable",
    datasetKey: "insertFooterSpacerWithDummyRowItemWhileFormatTable",
    legacyKey: "insert_footer_spacer_with_dummy_row_item_while_format_table",
    defaultValue: true,
    parser: parseBooleanFlag
  },
  {
    key: "customDummyRowItemContent",
    datasetKey: "customDummyRowItemContent",
    legacyKey: "custom_dummy_row_item_content",
    defaultValue: "",
    parser: parseString
  },
  {
    key: "customDummySpacerContent",
    datasetKey: "customDummySpacerContent",
    legacyKey: "custom_dummy_spacer_content",
    defaultValue: "",
    parser: parseString
  },
  { key: "debug", datasetKey: "debug", legacyKey: "debug_printform", defaultValue: false, parser: parseBooleanFlag }
];
var DOCINFO_VARIANTS = [
  { key: "docInfo", className: "pdocinfo", repeatFlag: "repeatDocinfo" },
  { key: "docInfo002", className: "pdocinfo002", repeatFlag: "repeatDocinfo002" },
  { key: "docInfo003", className: "pdocinfo003", repeatFlag: "repeatDocinfo003" },
  { key: "docInfo004", className: "pdocinfo004", repeatFlag: "repeatDocinfo004" },
  { key: "docInfo005", className: "pdocinfo005", repeatFlag: "repeatDocinfo005" }
];
var FOOTER_VARIANTS = [
  { key: "footer", className: "pfooter", repeatFlag: "repeatFooter" },
  { key: "footer002", className: "pfooter002", repeatFlag: "repeatFooter002" },
  { key: "footer003", className: "pfooter003", repeatFlag: "repeatFooter003" },
  { key: "footer004", className: "pfooter004", repeatFlag: "repeatFooter004" },
  { key: "footer005", className: "pfooter005", repeatFlag: "repeatFooter005" }
];
var FOOTER_LOGO_VARIANT = { key: "footerLogo", className: "pfooter_logo", repeatFlag: "repeatFooterLogo" };
var FOOTER_PAGENUM_VARIANT = { key: "footerPagenum", className: "pfooter_pagenum", repeatFlag: "repeatFooterPagenum" };
var DEFAULT_CONFIG = CONFIG_DESCRIPTORS.reduce((accumulator, descriptor) => {
  accumulator[descriptor.key] = descriptor.defaultValue;
  return accumulator;
}, {});
function readConfigFromLegacy(descriptors) {
  const source = typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : {};
  return descriptors.reduce((config, descriptor) => {
    if (!descriptor.legacyKey) return config;
    const value = source[descriptor.legacyKey];
    if (value === void 0 || value === null || value === "") return config;
    config[descriptor.key] = descriptor.parser(value, descriptor.defaultValue);
    return config;
  }, {});
}
function readConfigFromDataset(descriptors, dataset) {
  const source = dataset || {};
  return descriptors.reduce((config, descriptor) => {
    if (!descriptor.datasetKey) return config;
    if (!Object.prototype.hasOwnProperty.call(source, descriptor.datasetKey)) return config;
    const value = source[descriptor.datasetKey];
    if (value === void 0 || value === null || value === "") return config;
    config[descriptor.key] = descriptor.parser(value, descriptor.defaultValue);
    return config;
  }, {});
}
function getLegacyConfig() {
  return readConfigFromLegacy(CONFIG_DESCRIPTORS);
}
function getDatasetConfig(dataset) {
  return readConfigFromDataset(CONFIG_DESCRIPTORS, dataset);
}
function resolveTemplateOverride(formEl, className, fallback) {
  const template = formEl.querySelector(`template.${className}`);
  if (template) {
    return template.innerHTML.trim();
  }
  return fallback;
}
function getPrintformConfig(formEl, overrides = {}) {
  const legacy = getLegacyConfig();
  const datasetConfig = getDatasetConfig(formEl.dataset || {});
  const merged = {
    ...DEFAULT_CONFIG,
    ...legacy,
    ...datasetConfig,
    ...overrides
  };
  merged.customDummyRowItemContent = resolveTemplateOverride(
    formEl,
    "custom-dummy-row-item-content",
    overrides.customDummyRowItemContent !== void 0 ? overrides.customDummyRowItemContent : merged.customDummyRowItemContent
  );
  merged.customDummySpacerContent = resolveTemplateOverride(
    formEl,
    "custom-dummy-spacer-content",
    overrides.customDummySpacerContent !== void 0 ? overrides.customDummySpacerContent : merged.customDummySpacerContent
  );
  merged.debug = parseBooleanFlag(merged.debug, DEFAULT_CONFIG.debug);
  merged.nUp = parseNumber(merged.nUp, DEFAULT_CONFIG.nUp);
  if (!Number.isFinite(merged.nUp) || merged.nUp < 1) {
    merged.nUp = DEFAULT_CONFIG.nUp;
  }
  merged.nUp = Math.floor(merged.nUp);
  merged.showLogicalPageNumber = parseBooleanFlag(merged.showLogicalPageNumber, DEFAULT_CONFIG.showLogicalPageNumber);
  merged.showPhysicalPageNumber = parseBooleanFlag(merged.showPhysicalPageNumber, DEFAULT_CONFIG.showPhysicalPageNumber);
  merged.papersizeWidth = parseNumber(merged.papersizeWidth, DEFAULT_CONFIG.papersizeWidth);
  merged.papersizeHeight = parseNumber(merged.papersizeHeight, DEFAULT_CONFIG.papersizeHeight);
  merged.paperSize = parseString(merged.paperSize, DEFAULT_CONFIG.paperSize);
  merged.orientation = parseString(merged.orientation, DEFAULT_CONFIG.orientation);
  merged.dpi = parseNumber(merged.dpi, DEFAULT_CONFIG.dpi);
  if (!Number.isFinite(merged.dpi) || merged.dpi <= 0) merged.dpi = DEFAULT_CONFIG.dpi;
  const overrideHas = (key) => Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== "";
  const manualWidthProvided = Object.prototype.hasOwnProperty.call(legacy, "papersizeWidth") || Object.prototype.hasOwnProperty.call(datasetConfig, "papersizeWidth") || overrideHas("papersizeWidth");
  const manualHeightProvided = Object.prototype.hasOwnProperty.call(legacy, "papersizeHeight") || Object.prototype.hasOwnProperty.call(datasetConfig, "papersizeHeight") || overrideHas("papersizeHeight");
  if (!manualWidthProvided && !manualHeightProvided) {
    const resolved = resolvePaperDimensions({ paperSize: merged.paperSize, orientation: merged.orientation, dpi: merged.dpi });
    if (resolved) {
      merged.papersizeWidth = resolved.width;
      merged.papersizeHeight = resolved.height;
    }
  }
  return merged;
}
var PADDT_CONFIG_DESCRIPTORS = [
  { key: "repeatPaddt", datasetKey: "repeatPaddt", legacyKey: "repeat_paddt", defaultValue: true, parser: parseBooleanFlag },
  { key: "insertPaddtDummyRowItems", datasetKey: "insertPaddtDummyRowItems", legacyKey: "insert_paddt_dummy_row_items", defaultValue: true, parser: parseBooleanFlag },
  { key: "paddtMaxWordsPerSegment", datasetKey: "paddtMaxWordsPerSegment", legacyKey: "paddt_max_words_per_segment", defaultValue: 200, parser: parseNumber },
  { key: "repeatPaddtRowheader", datasetKey: "repeatPaddtRowheader", legacyKey: "repeat_paddt_rowheader", defaultValue: true, parser: parseBooleanFlag },
  { key: "paddtDebug", datasetKey: "paddtDebug", legacyKey: "paddt_debug", defaultValue: false, parser: parseBooleanFlag },
  // PADDT-specific docinfo toggles (show/hide on PADDT pages only)
  { key: "repeatPaddtDocinfo", datasetKey: "repeatPaddtDocinfo", legacyKey: "repeat_paddt_docinfo", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatPaddtDocinfo002", datasetKey: "repeatPaddtDocinfo002", legacyKey: "repeat_paddt_docinfo002", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatPaddtDocinfo003", datasetKey: "repeatPaddtDocinfo003", legacyKey: "repeat_paddt_docinfo003", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatPaddtDocinfo004", datasetKey: "repeatPaddtDocinfo004", legacyKey: "repeat_paddt_docinfo004", defaultValue: true, parser: parseBooleanFlag },
  { key: "repeatPaddtDocinfo005", datasetKey: "repeatPaddtDocinfo005", legacyKey: "repeat_paddt_docinfo005", defaultValue: true, parser: parseBooleanFlag }
];
var DEFAULT_PADDT_CONFIG = PADDT_CONFIG_DESCRIPTORS.reduce(function(acc, d) {
  acc[d.key] = d.defaultValue;
  return acc;
}, {});
function getPaddtLegacyConfig() {
  return readConfigFromLegacy(PADDT_CONFIG_DESCRIPTORS);
}
function getPaddtDatasetConfig(dataset) {
  return readConfigFromDataset(PADDT_CONFIG_DESCRIPTORS, dataset);
}
function getPaddtConfig(formEl, overrides) {
  overrides = overrides || {};
  var legacy = getPaddtLegacyConfig();
  var datasetConfig = getPaddtDatasetConfig(formEl && formEl.dataset || {});
  var merged = {};
  for (var k in DEFAULT_PADDT_CONFIG) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_PADDT_CONFIG, k)) merged[k] = DEFAULT_PADDT_CONFIG[k];
  }
  for (var k1 in legacy) {
    if (Object.prototype.hasOwnProperty.call(legacy, k1)) merged[k1] = legacy[k1];
  }
  for (var k2 in datasetConfig) {
    if (Object.prototype.hasOwnProperty.call(datasetConfig, k2)) merged[k2] = datasetConfig[k2];
  }
  for (var k3 in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, k3)) merged[k3] = overrides[k3];
  }
  merged.paddtDebug = parseBooleanFlag(merged.paddtDebug, DEFAULT_PADDT_CONFIG.paddtDebug);
  merged.paddtMaxWordsPerSegment = parseNumber(merged.paddtMaxWordsPerSegment, DEFAULT_PADDT_CONFIG.paddtMaxWordsPerSegment);
  if (!Number.isFinite(merged.paddtMaxWordsPerSegment) || merged.paddtMaxWordsPerSegment <= 0) {
    merged.paddtMaxWordsPerSegment = DEFAULT_PADDT_CONFIG.paddtMaxWordsPerSegment;
  }
  return merged;
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/dom.js
function applyTableSizingReset(table) {
  if (!table) return;
  table.style.borderCollapse = "collapse";
  table.style.borderSpacing = "0";
  table.style.margin = "0";
  table.style.padding = "0";
  table.style.lineHeight = "0";
  table.style.fontSize = "0";
}
function createDummyRowTable(config, height) {
  const table = document.createElement("table");
  table.className = "dummy_row";
  table.setAttribute("width", `${config.papersizeWidth}px`);
  table.setAttribute("cellspacing", "0");
  table.setAttribute("cellpadding", "0");
  applyTableSizingReset(table);
  table.innerHTML = `<tr style="height:${normalizeHeight(height)}px;"><td style="border:0px solid black;padding:0;margin:0;line-height:0;font-size:0;"></td></tr>`;
  return table;
}
function createDummyRowItemTable(config) {
  const table = document.createElement("table");
  table.className = "dummy_row_item";
  table.setAttribute("width", `${config.papersizeWidth}px`);
  table.setAttribute("cellspacing", "0");
  table.setAttribute("cellpadding", "0");
  applyTableSizingReset(table);
  table.style.borderCollapse = "separate";
  if (config.customDummyRowItemContent) {
    table.innerHTML = config.customDummyRowItemContent;
  } else {
    table.innerHTML = `<tr style="height:${normalizeHeight(config.heightOfDummyRowItem)}px;"><td style="border:0px solid black;padding:0;margin:0;line-height:0;font-size:0;"></td></tr>`;
  }
  return table;
}
function appendDummyRowItems(config, target, diffHeight) {
  const itemHeight = normalizeHeight(config.heightOfDummyRowItem);
  const remaining = normalizeHeight(diffHeight);
  if (itemHeight <= 0 || remaining <= 0) return;
  const count = Math.floor(remaining / itemHeight);
  for (let index = 0; index < count; index += 1) {
    target.appendChild(createDummyRowItemTable(config));
  }
}
function appendDummyRow(config, target, diffHeight) {
  const remaining = normalizeHeight(diffHeight);
  if (remaining <= 0) return;
  target.appendChild(createDummyRowTable(config, remaining));
}
function applyDummyRowItemsStep(config, container, heightPerPage, currentHeight, debug) {
  if (!config.insertDummyRowItemWhileFormatTable) {
    if (debug) {
      console.log(`[printform] applyDummyRowItemsStep: SKIPPED (insertDummyRowItemWhileFormatTable=false)`);
    }
    return normalizeHeight(currentHeight);
  }
  const remaining = normalizeHeight(heightPerPage - currentHeight);
  if (debug) {
    console.log(`[printform] applyDummyRowItemsStep:`);
    console.log(`[printform]   heightPerPage: ${heightPerPage}px, currentHeight: ${currentHeight}px`);
    console.log(`[printform]   remaining: ${remaining}px, itemHeight: ${config.heightOfDummyRowItem}px`);
  }
  if (remaining > 0) {
    appendDummyRowItems(config, container, remaining);
    const itemHeight = normalizeHeight(config.heightOfDummyRowItem);
    if (itemHeight > 0) {
      const count = Math.floor(remaining / itemHeight);
      const remainder = normalizeHeight(remaining % itemHeight);
      const newHeight = normalizeHeight(heightPerPage - remainder);
      if (debug) {
        console.log(`[printform]   inserted ${count} dummy_row_items (${count} x ${itemHeight}px = ${count * itemHeight}px)`);
        console.log(`[printform]   remainder: ${remainder}px, newHeight: ${newHeight}px`);
      }
      return newHeight;
    }
  }
  return normalizeHeight(currentHeight);
}
function applyDummyRowStep(config, container, heightPerPage, currentHeight, debug) {
  if (!config.insertDummyRowWhileFormatTable) {
    if (debug) {
      console.log(`[printform] applyDummyRowStep: SKIPPED (insertDummyRowWhileFormatTable=false)`);
    }
    return normalizeHeight(currentHeight);
  }
  const remaining = normalizeHeight(heightPerPage - currentHeight);
  if (debug) {
    console.log(`[printform] applyDummyRowStep:`);
    console.log(`[printform]   heightPerPage: ${heightPerPage}px, currentHeight: ${currentHeight}px`);
    console.log(`[printform]   remaining: ${remaining}px`);
  }
  if (remaining > 0) {
    appendDummyRow(config, container, remaining);
    if (debug) {
      console.log(`[printform]   inserted 1 dummy_row with height: ${remaining}px`);
    }
    return normalizeHeight(currentHeight + remaining);
  }
  return normalizeHeight(currentHeight);
}
function applyFooterSpacerWithDummyStep(config, container, heightPerPage, currentHeight, skipDummyRowItems, debug) {
  if (!config.insertFooterSpacerWithDummyRowItemWhileFormatTable || skipDummyRowItems) {
    if (debug) {
      console.log(`[printform] applyFooterSpacerWithDummyStep: SKIPPED (flag=${config.insertFooterSpacerWithDummyRowItemWhileFormatTable}, skipDummy=${skipDummyRowItems})`);
    }
    return {
      currentHeight: normalizeHeight(currentHeight),
      skipFooterSpacer: false
    };
  }
  const remaining = normalizeHeight(heightPerPage - currentHeight);
  let workingHeight = normalizeHeight(currentHeight);
  if (debug) {
    console.log(`[printform] applyFooterSpacerWithDummyStep:`);
    console.log(`[printform]   heightPerPage: ${heightPerPage}px, currentHeight: ${currentHeight}px`);
    console.log(`[printform]   remaining: ${remaining}px`);
  }
  if (remaining > 0) {
    appendDummyRowItems(config, container, remaining);
    const itemHeight = normalizeHeight(config.heightOfDummyRowItem);
    if (itemHeight > 0) {
      const count = Math.floor(remaining / itemHeight);
      const remainder = normalizeHeight(remaining % itemHeight);
      workingHeight = normalizeHeight(heightPerPage - remainder);
      if (debug) {
        console.log(`[printform]   inserted ${count} spacer dummy_row_items, remainder: ${remainder}px`);
      }
    }
  }
  return {
    currentHeight: workingHeight,
    skipFooterSpacer: true
  };
}
function applyFooterSpacerStep(config, container, heightPerPage, currentHeight, footerState, spacerTemplate, debug) {
  if (!config.insertFooterSpacerWhileFormatTable) {
    if (debug) {
      console.log(`[printform] applyFooterSpacerStep: SKIPPED (insertFooterSpacerWhileFormatTable=false)`);
    }
    return;
  }
  const clone = spacerTemplate.cloneNode(true);
  let remaining = normalizeHeight(heightPerPage - currentHeight);
  const nonRepeating = footerState && footerState.nonRepeating ? normalizeHeight(footerState.nonRepeating) : 0;
  if (nonRepeating > 0) {
    remaining -= nonRepeating;
  }
  const spacerHeight = Math.max(0, remaining);
  clone.style.height = `${spacerHeight}px`;
  container.appendChild(clone);
  if (debug) {
    console.log(`[printform] applyFooterSpacerStep:`);
    console.log(`[printform]   heightPerPage: ${heightPerPage}px, currentHeight: ${currentHeight}px`);
    console.log(`[printform]   nonRepeatingFooter: ${nonRepeating}px`);
    console.log(`[printform]   pfooter_spacer height: ${spacerHeight}px`);
  }
}
function markAsProcessed(element, baseClass) {
  if (!element || !baseClass) return;
  if (element.classList.contains(`${baseClass}_processed`)) return;
  element.classList.remove(baseClass);
  element.classList.add(`${baseClass}_processed`);
}
function measureHeight(element) {
  if (!element) return 0;
  element.offsetHeight;
  const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
  const rectHeight = rect && Number.isFinite(rect.height) ? rect.height : 0;
  let baseHeight = rectHeight > 0 ? rectHeight : element.offsetHeight;
  if (baseHeight === 0) {
    const originalDisplay = element.style.display;
    const originalVisibility = element.style.visibility;
    const originalPosition = element.style.position;
    element.style.display = "block";
    element.style.visibility = "hidden";
    element.style.position = "absolute";
    const tempRect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    const tempRectHeight = tempRect && Number.isFinite(tempRect.height) ? tempRect.height : 0;
    baseHeight = tempRectHeight > 0 ? tempRectHeight : element.offsetHeight || 0;
    element.style.display = originalDisplay;
    element.style.visibility = originalVisibility;
    element.style.position = originalPosition;
  }
  const view = element.ownerDocument && element.ownerDocument.defaultView || (typeof window !== "undefined" ? window : null);
  if (!view || !view.getComputedStyle) {
    return normalizeHeight(baseHeight);
  }
  const style = view.getComputedStyle(element);
  const marginTop = Number.parseFloat(style.marginTop) || 0;
  const marginBottom = Number.parseFloat(style.marginBottom) || 0;
  return normalizeHeight(baseHeight + marginTop + marginBottom);
}
function measureHeightRaw(element) {
  if (!element) return 0;
  const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
  const baseHeight = rect && Number.isFinite(rect.height) ? rect.height : element.offsetHeight || 0;
  const view = element.ownerDocument && element.ownerDocument.defaultView || (typeof window !== "undefined" ? window : null);
  if (!view || !view.getComputedStyle) {
    return Number.isFinite(baseHeight) ? Math.max(0, baseHeight) : 0;
  }
  const style = view.getComputedStyle(element);
  const marginTop = Number.parseFloat(style.marginTop) || 0;
  const marginBottom = Number.parseFloat(style.marginBottom) || 0;
  const total = baseHeight + marginTop + marginBottom;
  return Number.isFinite(total) ? Math.max(0, total) : 0;
}
function createPageBreakDivider(extraClassNames) {
  const div = document.createElement("div");
  div.classList.add("div_page_break_before");
  div.setAttribute("style", "page-break-before: always; font-size: 0pt; height: 0px;");
  const globalScope2 = typeof window !== "undefined" ? window : globalThis;
  const resolvedClassNames = typeof extraClassNames === "string" && extraClassNames.trim() ? extraClassNames : globalScope2 && typeof globalScope2.__printFormDividerClassAppend === "string" ? globalScope2.__printFormDividerClassAppend : "";
  if (resolvedClassNames) {
    resolvedClassNames.split(/\s+/).filter(Boolean).forEach((className) => div.classList.add(className));
  }
  return div;
}
function appendClone(target, element, logFn, label) {
  if (!element) return null;
  const clone = element.cloneNode(true);
  target.appendChild(clone);
  if (logFn) logFn(`append ${label}`);
  return clone;
}
function appendRowItem(target, element, logFn, index, label) {
  if (!element) return null;
  const clone = element.cloneNode(true);
  target.appendChild(clone);
  if (logFn) {
    const resolvedLabel = label || "prowitem";
    logFn(`append ${resolvedLabel} ${index}`);
  }
  return clone;
}
var DomHelpers = {
  markAsProcessed,
  measureHeight,
  measureHeightRaw,
  createPageBreakDivider,
  appendClone,
  appendRowItem,
  createDummyRowTable
};

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/pages.js
function buildDummySpacer(config, remaining, debug) {
  if (config.customDummySpacerContent) {
    const template = document.createElement("template");
    template.innerHTML = config.customDummySpacerContent.trim();
    const elements = Array.from(template.content.childNodes).filter((node) => node.nodeType === Node.ELEMENT_NODE);
    if (elements.length === 1) {
      const spacer2 = elements[0];
      spacer2.classList.add("dummy_spacer");
      spacer2.setAttribute("aria-hidden", "true");
      if (spacer2.tagName !== "TABLE") {
        spacer2.style.display = "block";
      }
      spacer2.style.width = "100%";
      spacer2.style.height = `${remaining}px`;
      spacer2.style.margin = "0";
      spacer2.style.padding = "0";
      return spacer2;
    }
    if (debug) {
      console.log("[printform] customDummySpacerContent ignored: template must have exactly 1 root element.");
    }
  }
  const spacer = document.createElement("div");
  spacer.classList.add("dummy_spacer");
  spacer.setAttribute("aria-hidden", "true");
  if (spacer.tagName !== "TABLE") {
    spacer.style.display = "block";
  }
  spacer.style.width = "100%";
  spacer.style.height = `${remaining}px`;
  spacer.style.margin = "0";
  spacer.style.padding = "0";
  return spacer;
}
function attachPageMethods(FormatterClass) {
  FormatterClass.prototype.initializeOutputContainer = function initializeOutputContainer() {
    const container = document.createElement("div");
    container.classList.add("printform_formatter");
    container.style.webkitTextSizeAdjust = "100%";
    container.style.textSizeAdjust = "100%";
    this.formEl.parentNode.insertBefore(container, this.formEl);
    return container;
  };
  FormatterClass.prototype.initializePhysicalWrapper = function initializePhysicalWrapper(outputContainer) {
    if (this.currentPhysicalWrapper) {
      outputContainer.appendChild(DomHelpers.createPageBreakDivider());
      this.currentPhysicalPage += 1;
    } else {
      this.currentPhysicalPage = 1;
    }
    const wrapper = document.createElement("div");
    wrapper.classList.add("physical_page_wrapper");
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "flex-start";
    wrapper.style.width = `${this.config.papersizeWidth}px`;
    outputContainer.appendChild(wrapper);
    this.currentPhysicalWrapper = wrapper;
    this.pagesInCurrentPhysical = 0;
    return wrapper;
  };
  FormatterClass.prototype.ensureCurrentPageContainer = function ensureCurrentPageContainer(outputContainer) {
    if (!this.currentPhysicalWrapper) {
      this.initializePhysicalWrapper(outputContainer);
    }
    if (!this.currentPageContainer) {
      this.createNewLogicalPage(outputContainer);
    }
    return this.currentPageContainer;
  };
  FormatterClass.prototype.createNewLogicalPage = function createNewLogicalPage(outputContainer) {
    if (!this.currentPhysicalWrapper || this.pagesInCurrentPhysical >= this.nUp) {
      this.initializePhysicalWrapper(outputContainer);
    }
    const page = document.createElement("div");
    page.classList.add("printform_page");
    page.style.width = `${this.config.papersizeWidth}px`;
    this.currentPhysicalWrapper.appendChild(page);
    this.currentPageContainer = page;
    this.pagesInCurrentPhysical += 1;
    this.logicalPageToPhysicalPage[this.currentPage] = this.currentPhysicalPage;
    return page;
  };
  FormatterClass.prototype.getCurrentPageContainer = function getCurrentPageContainer(outputContainer) {
    return this.ensureCurrentPageContainer(outputContainer);
  };
  FormatterClass.prototype.finalizePageHeight = function finalizePageHeight(pageContainer) {
    if (!pageContainer) return;
    const configuredHeight = this.config.papersizeHeight;
    const fillPageHeightAfterFooter = this.config.fillPageHeightAfterFooter !== false;
    let appendedSpacerHeight = 0;
    const formatPx = (value) => {
      if (!Number.isFinite(value)) return "0";
      return String(Math.round(value * 100) / 100);
    };
    if (fillPageHeightAfterFooter) {
      const currentHeight = DomHelpers.measureHeightRaw(pageContainer);
      const remaining = Math.max(0, configuredHeight - currentHeight);
      if (remaining > 0.01) {
        const spacer = buildDummySpacer(this.config, remaining, this.debug);
        const footerSelectors = FOOTER_VARIANTS.map((variant) => `.${variant.className}_processed`).concat([
          `.${FOOTER_LOGO_VARIANT.className}_processed`,
          `.${FOOTER_PAGENUM_VARIANT.className}_processed`
        ]);
        const firstFooter = pageContainer.querySelector(footerSelectors.join(", "));
        if (firstFooter && firstFooter.parentNode === pageContainer) {
          pageContainer.insertBefore(spacer, firstFooter);
        } else {
          pageContainer.appendChild(spacer);
        }
        appendedSpacerHeight = remaining;
      }
    }
    if (this.debug) {
      console.log(`
[printform] ========== PAGE HEIGHT CALCULATION ==========`);
      console.log(`[printform] Configured page height: ${configuredHeight}px`);
      console.log(`[printform] -------------------------------------------`);
      const children = Array.from(pageContainer.children);
      let cumulativeHeight = 0;
      console.log(`[printform] Elements breakdown (${children.length} elements):`);
      children.forEach((child, index) => {
        const childHeight = DomHelpers.measureHeightRaw(child);
        cumulativeHeight += childHeight;
        const className = child.className || "(no class)";
        const tagName = child.tagName.toLowerCase();
        console.log(`[printform]   ${index + 1}. <${tagName}.${className}>`);
        console.log(`[printform]      Height: ${formatPx(childHeight)}px`);
        console.log(`[printform]      Cumulative: ${formatPx(cumulativeHeight)}px`);
        console.log(`[printform]      Remaining: ${formatPx(Math.max(0, configuredHeight - cumulativeHeight))}px`);
        if (childHeight > configuredHeight * 0.5) {
          console.log(`[printform]      \u26A0\uFE0F  WARNING: Element height is > 50% of page height`);
        }
      });
      console.log(`[printform] -------------------------------------------`);
      console.log(`[printform] Total content height: ${formatPx(cumulativeHeight)}px`);
      if (cumulativeHeight < configuredHeight) {
        const shortfall = configuredHeight - cumulativeHeight;
        console.log(`[printform] \u2713 Content fits (${formatPx(shortfall)}px under limit)`);
      } else if (cumulativeHeight > configuredHeight) {
        const overflow = cumulativeHeight - configuredHeight;
        console.log(`[printform] \u26A0\uFE0F  Content overflow (${formatPx(overflow)}px over limit)`);
      } else {
        console.log(`[printform] \u2713 Perfect fit (exactly matches configured height)`);
      }
      if (appendedSpacerHeight > 0) {
        console.log(`[printform] \u2713 Final spacer appended: ${formatPx(appendedSpacerHeight)}px`);
      }
    }
    if (this.debug) {
      const actualHeight = DomHelpers.measureHeightRaw(pageContainer);
      console.log(`[printform] -------------------------------------------`);
      console.log(`[printform] Actual measured height: ${formatPx(actualHeight)}px`);
      console.log(`[printform] \u2139\uFE0F  Height NOT set - using natural content height`);
      console.log(`[printform] ===============================================
`);
    }
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/text.js
var ROW_SELECTOR = ".prowitem, .ptac-rowitem, .paddt-rowitem";
var PTAC_MAX_WORDS_PER_SEGMENT = 200;
var PADDT_MAX_WORDS_PER_SEGMENT = 200;
function collectWordTokens(node) {
  var tokens = [];
  if (!node || !node.ownerDocument || !node.ownerDocument.createTreeWalker) {
    return tokens;
  }
  var walker = node.ownerDocument.createTreeWalker(node, 4, null, false);
  var current = walker.nextNode();
  while (current) {
    var text = current.nodeValue || "";
    var regex = /\S+/g;
    var match = regex.exec(text);
    while (match) {
      tokens.push({
        node: current,
        start: match.index,
        end: match.index + match[0].length
      });
      match = regex.exec(text);
    }
    current = walker.nextNode();
  }
  return tokens;
}
function buildChunkHtml(node, range) {
  var clone = node.cloneNode(false);
  clone.appendChild(range.cloneContents());
  return clone.outerHTML || "";
}
function splitParagraphIntoHtmlChunks(node, maxWords) {
  if (!node) {
    return [];
  }
  if (!maxWords || maxWords <= 0) {
    return [node.outerHTML || ""];
  }
  var text = (node.textContent || "").trim();
  if (!text) {
    return [node.outerHTML || ""];
  }
  if (!node.ownerDocument || !node.ownerDocument.createRange || !node.ownerDocument.createTreeWalker) {
    return [node.outerHTML || ""];
  }
  var tokens = collectWordTokens(node);
  if (tokens.length === 0) {
    return [node.outerHTML || ""];
  }
  if (tokens.length <= maxWords) {
    return [node.outerHTML || ""];
  }
  var chunks = [];
  for (var startIndex = 0; startIndex < tokens.length; startIndex += maxWords) {
    var endIndex = startIndex + maxWords - 1;
    if (endIndex >= tokens.length) {
      endIndex = tokens.length - 1;
    }
    var range = node.ownerDocument.createRange();
    if (startIndex === 0) {
      range.setStart(node, 0);
    } else {
      var startToken = tokens[startIndex];
      range.setStart(startToken.node, startToken.start);
    }
    if (endIndex + 1 < tokens.length) {
      var nextToken = tokens[endIndex + 1];
      range.setEnd(nextToken.node, nextToken.start);
    } else {
      range.setEnd(node, node.childNodes.length);
    }
    chunks.push(buildChunkHtml(node, range));
  }
  return chunks;
}
function splitPaddtParagraphIntoHtmlChunks(node, maxWords) {
  return splitParagraphIntoHtmlChunks(node, maxWords);
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/sections.js
function attachSectionMethods(FormatterClass) {
  FormatterClass.prototype.collectSections = function collectSections() {
    this.expandPaddtSegments();
    this.expandPtacSegments();
    const docInfos = DOCINFO_VARIANTS.map((variant) => {
      const element = this.formEl.querySelector(`.${variant.className}`);
      if (!element) return null;
      return {
        key: variant.key,
        className: variant.className,
        repeatFlag: variant.repeatFlag,
        element
      };
    }).filter(Boolean);
    const footerVariants = FOOTER_VARIANTS.map((variant) => {
      const element = this.formEl.querySelector(`.${variant.className}`);
      if (!element) return null;
      return {
        key: variant.key,
        className: variant.className,
        repeatFlag: variant.repeatFlag,
        element
      };
    }).filter(Boolean);
    const allRows = Array.from(this.formEl.querySelectorAll(ROW_SELECTOR));
    const paddtRows = allRows.filter((row) => this.isPaddtRow(row));
    const mainRows = allRows.filter((row) => !this.isPaddtRow(row));
    const rowHeaders = Array.from(this.formEl.querySelectorAll(".prowheader"));
    const rowHeadersById = {};
    rowHeaders.forEach((header) => {
      const tableId = this.getRowTableId(header);
      if (!rowHeadersById[tableId]) rowHeadersById[tableId] = header;
    });
    this.paddtRows = paddtRows;
    return {
      header: this.formEl.querySelector(".pheader"),
      docInfos,
      rowHeader: rowHeaders[0] || null,
      rowHeaders,
      rowHeadersById,
      footerVariants,
      footerLogo: this.formEl.querySelector(`.${FOOTER_LOGO_VARIANT.className}`),
      footerPagenum: this.formEl.querySelector(`.${FOOTER_PAGENUM_VARIANT.className}`),
      rows: mainRows
    };
  };
  FormatterClass.prototype.measureSections = function measureSections(sections) {
    const heights = {
      header: DomHelpers.measureHeight(sections.header),
      docInfos: {},
      rowHeader: DomHelpers.measureHeight(sections.rowHeader),
      rowHeaders: Object.fromEntries((sections.rowHeaders || []).map((header) => [this.getRowTableId(header), DomHelpers.measureHeight(header)])),
      footerVariants: {},
      footerLogo: DomHelpers.measureHeight(sections.footerLogo),
      footerPagenum: DomHelpers.measureHeight(sections.footerPagenum)
    };
    sections.docInfos.forEach((docInfo) => {
      heights.docInfos[docInfo.key] = DomHelpers.measureHeight(docInfo.element);
    });
    sections.footerVariants.forEach((footer) => {
      heights.footerVariants[footer.key] = DomHelpers.measureHeight(footer.element);
    });
    return heights;
  };
  FormatterClass.prototype.markSectionsProcessed = function markSectionsProcessed(sections) {
    DomHelpers.markAsProcessed(sections.header, "pheader");
    sections.docInfos.forEach((docInfo) => {
      DomHelpers.markAsProcessed(docInfo.element, docInfo.className);
    });
    (sections.rowHeaders || [sections.rowHeader]).forEach((header) => DomHelpers.markAsProcessed(header, "prowheader"));
    sections.footerVariants.forEach((footer) => {
      DomHelpers.markAsProcessed(footer.element, footer.className);
    });
    DomHelpers.markAsProcessed(sections.footerLogo, FOOTER_LOGO_VARIANT.className);
    DomHelpers.markAsProcessed(sections.footerPagenum, FOOTER_PAGENUM_VARIANT.className);
  };
  FormatterClass.prototype.createFooterSpacerTemplate = function createFooterSpacerTemplate() {
    const spacer = document.createElement("div");
    spacer.classList.add("pfooter_spacer", "paper_width");
    spacer.style.height = "0px";
    return spacer;
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/row-types.js
function attachRowTypeMethods(FormatterClass) {
  FormatterClass.prototype.isPaddtRow = function isPaddtRow(row) {
    if (!row) {
      return false;
    }
    return row.classList.contains("paddt_segment") || row.classList.contains("paddt") || row.classList.contains("paddt-rowitem") || row.classList.contains("paddt-rowitem_processed");
  };
  FormatterClass.prototype.isPtacRow = function isPtacRow(row) {
    if (!row) {
      return false;
    }
    return row.classList.contains("ptac_segment") || row.classList.contains("ptac") || row.classList.contains("ptac-rowitem") || row.classList.contains("ptac-rowitem_processed");
  };
  FormatterClass.prototype.isSubtotalRow = function isSubtotalRow(row) {
    if (!row) {
      return false;
    }
    return row.classList.contains("prowitem_subtotal");
  };
  FormatterClass.prototype.isFooterRow = function isFooterRow(row) {
    if (!row) {
      return false;
    }
    return row.classList.contains("prowitem_footer");
  };
  FormatterClass.prototype.getRowBaseClass = function getRowBaseClass(row) {
    if (!row) {
      return "prowitem";
    }
    if (this.isPaddtRow(row)) return "paddt-rowitem";
    return this.isPtacRow(row) ? "ptac-rowitem" : "prowitem";
  };
  FormatterClass.prototype.getRowTableId = function getRowTableId(row) {
    return row?.getAttribute?.("data-pf-table-id") || row?.getAttribute?.("data-pf-table") || "default";
  };
  FormatterClass.prototype.shouldSkipRowHeaderForRow = function shouldSkipRowHeaderForRow(row) {
    if (!row) {
      return false;
    }
    if (!this.config.repeatRowheader) {
      return false;
    }
    if (row.classList.contains("without_prowheader") || row.classList.contains("tb_without_rowheader")) {
      return true;
    }
    if (this.isPtacRow(row)) {
      if (this.config.repeatPtacRowheader) return false;
      return true;
    }
    if (this.isPaddtRow(row)) {
      if (this.paddtConfig && this.paddtConfig.repeatPaddtRowheader) return false;
      return true;
    }
    return false;
  };
  FormatterClass.prototype.shouldSkipDummyRowItemsForContext = function shouldSkipDummyRowItemsForContext(pageContext) {
    return Boolean(
      pageContext && (pageContext.isPtacPage && !this.config.insertPtacDummyRowItems || pageContext.isPaddtPage && !(this.paddtConfig && this.paddtConfig.insertPaddtDummyRowItems))
    );
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/row-header-policy.js
function flag(value, fallback = true) {
  if (value === void 0 || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).trim().toLowerCase());
}
function hasTableMap(sections) {
  return Object.keys(sections?.rowHeadersById || {}).length > 0;
}
function attachRowHeaderPolicyMethods(FormatterClass) {
  FormatterClass.prototype.getSectionRowHeader = function getSectionRowHeader(sections, tableId = "default") {
    const rowHeadersById = sections?.rowHeadersById || {};
    if (Object.prototype.hasOwnProperty.call(rowHeadersById, tableId)) return rowHeadersById[tableId];
    if (hasTableMap(sections)) return null;
    return sections?.rowHeader || null;
  };
  FormatterClass.prototype.isRowHeaderRepeated = function isRowHeaderRepeated(sections, tableId = "default") {
    const header = this.getSectionRowHeader(sections, tableId);
    if (!header) return false;
    const localValue = typeof header.getAttribute === "function" ? header.getAttribute("data-pf-repeat-rowheader") : void 0;
    return flag(localValue, Boolean(this.config.repeatRowheader));
  };
  FormatterClass.prototype.maxRepeatingRowHeaderHeight = function maxRepeatingRowHeaderHeight(sections, heights) {
    const headers = sections?.rowHeaders?.length ? sections.rowHeaders : [sections?.rowHeader].filter(Boolean);
    const values = headers.filter((header) => this.isRowHeaderRepeated(sections, this.getRowTableId?.(header) || "default")).map((header) => {
      const tableId = this.getRowTableId?.(header) || "default";
      return heights?.rowHeaders?.[tableId] ?? heights?.rowHeader ?? 0;
    });
    return values.length ? Math.max(...values) : 0;
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/segments-paddt.js
function attachPaddtSegmentMethods(FormatterClass) {
  FormatterClass.prototype.expandPaddtSegments = function expandPaddtSegments() {
    if (this.formEl.dataset.paddtExpanded === "true") {
      return;
    }
    const paddtTables = Array.from(this.formEl.querySelectorAll(".paddt"));
    if (paddtTables.length === 0) {
      this.formEl.dataset.paddtExpanded = "true";
      return;
    }
    var maxWords = this.paddtConfig && this.paddtConfig.paddtMaxWordsPerSegment || PADDT_MAX_WORDS_PER_SEGMENT;
    paddtTables.forEach((paddtRoot) => {
      if (!paddtRoot || paddtRoot.dataset.paddtSegment === "true") {
        return;
      }
      const contentWrapper = paddtRoot.querySelector("td > div") || paddtRoot.querySelector("td");
      if (!contentWrapper) {
        paddtRoot.classList.add("paddt-rowitem", "paddt_segment");
        paddtRoot.dataset.paddtSegment = "true";
        return;
      }
      const allChildren = Array.from(contentWrapper.children);
      if (allChildren.length === 0) {
        paddtRoot.classList.add("paddt-rowitem", "paddt_segment");
        paddtRoot.dataset.paddtSegment = "true";
        return;
      }
      const segments = [];
      allChildren.forEach((child) => {
        if (child.tagName.toLowerCase() === "p") {
          const chunks = splitPaddtParagraphIntoHtmlChunks(child, maxWords);
          chunks.forEach((chunk) => segments.push(chunk));
        } else {
          segments.push(child.outerHTML);
        }
      });
      if (segments.length === 0) {
        paddtRoot.classList.add("paddt-rowitem", "paddt_segment");
        paddtRoot.dataset.paddtSegment = "true";
        return;
      }
      contentWrapper.innerHTML = segments[0];
      paddtRoot.classList.add("paddt-rowitem", "paddt_segment");
      paddtRoot.dataset.paddtSegment = "true";
      var lastNode = paddtRoot;
      for (var index = 1; index < segments.length; index += 1) {
        const clone = paddtRoot.cloneNode(true);
        clone.classList.remove("tb_page_break_before");
        clone.dataset.paddtSegment = "true";
        const cloneWrapper = clone.querySelector("td > div") || clone.querySelector("td");
        if (cloneWrapper) {
          cloneWrapper.innerHTML = segments[index];
        }
        lastNode.parentNode.insertBefore(clone, lastNode.nextSibling);
        lastNode = clone;
      }
    });
    this.formEl.dataset.paddtExpanded = "true";
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/segments-ptac.js
function attachPtacSegmentMethods(FormatterClass) {
  FormatterClass.prototype.expandPtacSegments = function expandPtacSegments() {
    if (this.formEl.dataset.ptacExpanded === "true") {
      return;
    }
    const ptacTables = Array.from(this.formEl.querySelectorAll(".ptac"));
    if (ptacTables.length === 0) {
      this.formEl.dataset.ptacExpanded = "true";
      return;
    }
    ptacTables.forEach((ptacRoot) => {
      if (!ptacRoot || ptacRoot.dataset.ptacSegment === "true") {
        return;
      }
      const contentWrapper = ptacRoot.querySelector("td > div") || ptacRoot.querySelector("td");
      if (!contentWrapper) {
        ptacRoot.classList.add("ptac-rowitem", "ptac_segment");
        ptacRoot.dataset.ptacSegment = "true";
        return;
      }
      const allChildren = Array.from(contentWrapper.children);
      if (allChildren.length === 0) {
        ptacRoot.classList.add("ptac-rowitem", "ptac_segment");
        ptacRoot.dataset.ptacSegment = "true";
        return;
      }
      const segments = [];
      allChildren.forEach((child) => {
        if (child.tagName.toLowerCase() === "p") {
          const chunks = splitParagraphIntoHtmlChunks(child, PTAC_MAX_WORDS_PER_SEGMENT);
          chunks.forEach((chunk) => segments.push(chunk));
        } else {
          segments.push(child.outerHTML);
        }
      });
      if (segments.length === 0) {
        ptacRoot.classList.add("ptac-rowitem", "ptac_segment");
        ptacRoot.dataset.ptacSegment = "true";
        return;
      }
      contentWrapper.innerHTML = segments[0];
      ptacRoot.classList.add("ptac-rowitem", "ptac_segment");
      ptacRoot.dataset.ptacSegment = "true";
      var lastNode = ptacRoot;
      for (var index = 1; index < segments.length; index += 1) {
        const clone = ptacRoot.cloneNode(true);
        clone.classList.remove("tb_page_break_before");
        clone.dataset.ptacSegment = "true";
        const cloneWrapper = clone.querySelector("td > div") || clone.querySelector("td");
        if (cloneWrapper) {
          cloneWrapper.innerHTML = segments[index];
        }
        lastNode.parentNode.insertBefore(clone, lastNode.nextSibling);
        lastNode = clone;
      }
    });
    this.formEl.dataset.ptacExpanded = "true";
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/rendering.js
function attachRenderingMethods(FormatterClass) {
  if (!FormatterClass.prototype.getSectionRowHeader) attachRowHeaderPolicyMethods(FormatterClass);
  FormatterClass.prototype.ensureFirstPageSections = function ensureFirstPageSections(container, sections, heights, logFn, skipRowHeader, tableId = "default") {
    let consumedHeight = 0;
    if (sections.header) {
      DomHelpers.appendClone(container, sections.header, logFn, "pheader");
      if (!this.config.repeatHeader) {
        consumedHeight += heights.header;
      }
    }
    sections.docInfos.forEach((docInfo) => {
      const clone = DomHelpers.appendClone(container, docInfo.element, logFn, docInfo.className);
      this.registerPageNumberClone(clone);
      if (!this.config[docInfo.repeatFlag]) {
        consumedHeight += heights.docInfos[docInfo.key] || 0;
      }
    });
    const rowHeader = this.getSectionRowHeader(sections, tableId);
    if (rowHeader && !skipRowHeader) {
      DomHelpers.appendClone(container, rowHeader, logFn, "prowheader");
      if (!this.isRowHeaderRepeated(sections, tableId)) {
        consumedHeight += heights.rowHeaders?.[tableId] ?? heights.rowHeader ?? 0;
      }
    }
    return consumedHeight;
  };
  FormatterClass.prototype.appendRepeatingSections = function appendRepeatingSections(container, sections, logFn, skipRowHeader, tableId = "default") {
    if (this.config.repeatHeader) {
      DomHelpers.appendClone(container, sections.header, logFn, "pheader");
    }
    sections.docInfos.forEach((docInfo) => {
      if (this.config[docInfo.repeatFlag]) {
        const clone = DomHelpers.appendClone(container, docInfo.element, logFn, docInfo.className);
        this.registerPageNumberClone(clone);
      }
    });
    const rowHeader = this.getSectionRowHeader(sections, tableId);
    if (this.isRowHeaderRepeated(sections, tableId) && rowHeader && !skipRowHeader) {
      DomHelpers.appendClone(container, rowHeader, logFn, "prowheader");
    }
  };
  FormatterClass.prototype.ensureActiveTableHeader = function ensureActiveTableHeader(container, sections, logFn, tableId) {
    if (!this.isRowHeaderRepeated(sections, tableId)) return null;
    const rowHeader = this.getSectionRowHeader(sections, tableId);
    if (!rowHeader) return null;
    const hasHeader = Array.from(container.querySelectorAll(".prowheader_processed")).some(
      (node) => this.getRowTableId(node) === tableId
    );
    if (hasHeader) return null;
    return DomHelpers.appendClone(container, rowHeader, logFn, "prowheader");
  };
  FormatterClass.prototype.registerPageNumberClone = function registerPageNumberClone(node) {
    if (!node) {
      return false;
    }
    let registered = false;
    if (this.showLogicalPageNumber) {
      if (node.querySelector("[data-page-number], [data-page-total], [data-page-number-container]")) {
        updatePageNumberContent(node, this.currentPage, null);
        this.logicalPageNumberClones.push({ node, pageNumber: this.currentPage });
        registered = true;
      }
    }
    if (this.showPhysicalPageNumber) {
      if (node.querySelector("[data-physical-page-number], [data-physical-page-total], [data-physical-page-number-container]")) {
        const physicalPage = this.logicalPageToPhysicalPage[this.currentPage] || this.currentPhysicalPage || 1;
        updatePhysicalPageNumberContent(node, physicalPage, null);
        this.physicalPageNumberClones.push({ node, pageNumber: physicalPage });
        registered = true;
      }
    }
    return registered;
  };
  FormatterClass.prototype.appendRepeatingFooters = function appendRepeatingFooters(container, sections, logFn) {
    sections.footerVariants.forEach((footer) => {
      if (this.config[footer.repeatFlag]) {
        DomHelpers.appendClone(container, footer.element, logFn, footer.className);
      }
    });
    if (this.config.repeatFooterLogo) {
      DomHelpers.appendClone(container, sections.footerLogo, logFn, FOOTER_LOGO_VARIANT.className);
    }
    if (this.config.repeatFooterPagenum) {
      this.appendFooterPageNumber(container, sections, logFn);
    }
  };
  FormatterClass.prototype.appendFinalFooters = function appendFinalFooters(container, sections, logFn) {
    sections.footerVariants.forEach((footer) => {
      DomHelpers.appendClone(container, footer.element, logFn, footer.className);
    });
    DomHelpers.appendClone(container, sections.footerLogo, logFn, FOOTER_LOGO_VARIANT.className);
    this.appendFooterPageNumber(container, sections, logFn);
  };
  FormatterClass.prototype.appendFooterPageNumber = function appendFooterPageNumber(container, sections, logFn) {
    if (!sections.footerPagenum) {
      return;
    }
    const clone = sections.footerPagenum.cloneNode(true);
    container.appendChild(clone);
    this.registerPageNumberClone(clone);
    if (logFn) {
      logFn(`append ${FOOTER_PAGENUM_VARIANT.className} page ${this.currentPage}`);
    }
  };
  FormatterClass.prototype.updatePageNumberTotals = function updatePageNumberTotals() {
    if (!this.logicalPageNumberClones.length && !this.physicalPageNumberClones.length) {
      return;
    }
    const totalLogicalPages = this.currentPage;
    const totalPhysicalPages = this.currentPhysicalPage || 1;
    this.logicalPageNumberClones.forEach((entry) => {
      updatePageNumberContent(entry.node, entry.pageNumber, totalLogicalPages);
    });
    this.physicalPageNumberClones.forEach((entry) => {
      updatePhysicalPageNumberContent(entry.node, entry.pageNumber, totalPhysicalPages);
    });
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/pagination-context.js
function attachPaginationContextMethods(FormatterClass) {
  FormatterClass.prototype.initializePageContext = function initializePageContext(heightPerPage) {
    return {
      baseLimit: heightPerPage,
      limit: heightPerPage,
      skipRowHeader: false,
      tableId: "default",
      rowHeaderHeight: 0,
      isPtacPage: false,
      isPaddtPage: false,
      repeatingHeight: 0
    };
  };
  FormatterClass.prototype.refreshPageContextForRow = function refreshPageContextForRow(pageContext, row, heights, sections) {
    if (!pageContext) {
      return pageContext;
    }
    const skipRowHeader = this.shouldSkipRowHeaderForRow(row);
    const tableId = this.getRowTableId(row);
    const rowHeaderHeight = heights.rowHeaders?.[tableId] ?? heights.rowHeader ?? 0;
    pageContext.skipRowHeader = skipRowHeader;
    pageContext.tableId = tableId;
    pageContext.rowHeaderHeight = rowHeaderHeight;
    pageContext.isPtacPage = this.isPtacRow(row);
    pageContext.isPaddtPage = this.isPaddtRow(row);
    pageContext.limit = pageContext.baseLimit + (skipRowHeader ? rowHeaderHeight : 0);
    return pageContext;
  };
  FormatterClass.prototype.computeRepeatingHeightForPage = function computeRepeatingHeightForPage(sections, heights, skipRowHeader, tableId = "default") {
    let total = 0;
    if (this.config.repeatHeader && sections.header) {
      total += heights.header || 0;
    }
    sections.docInfos.forEach((docInfo) => {
      if (this.config[docInfo.repeatFlag]) {
        total += heights.docInfos[docInfo.key] || 0;
      }
    });
    const rowHeader = sections.rowHeadersById?.[tableId] || sections.rowHeader;
    if (this.isRowHeaderRepeated(sections, tableId) && rowHeader && !skipRowHeader) {
      total += heights.rowHeaders?.[tableId] ?? heights.rowHeader ?? 0;
    }
    return normalizeHeight(total);
  };
  FormatterClass.prototype.measureContentHeight = function measureContentHeight(container, repeatingHeight) {
    const total = DomHelpers.measureHeightRaw(container);
    return normalizeHeight(total - (repeatingHeight || 0));
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/pagination-dummy.js
function parseDummyRowContent(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const elements = Array.from(template.content.childNodes).filter((node) => node.nodeType === Node.ELEMENT_NODE);
  if (elements.length === 0) return null;
  if (elements.length === 1) return elements[0];
  const table = document.createElement("table");
  table.setAttribute("cellpadding", "0");
  table.setAttribute("cellspacing", "0");
  table.setAttribute("border", "0");
  table.style.width = "100%";
  table.style.tableLayout = "fixed";
  elements.forEach((el) => table.appendChild(el));
  return table;
}
function attachPaginationDummyMethods(FormatterClass) {
  FormatterClass.prototype.insertFooterDummyRows = function insertFooterDummyRows(container, pageContext, currentHeight, reservedHeight, footerLabel) {
    const availableSpace = pageContext.limit - currentHeight - reservedHeight;
    const dummyHeight = this.config.heightOfDummyRowItem || 27;
    const numDummies = Math.floor(availableSpace / dummyHeight);
    if (numDummies > 0 && this.debug) {
      console.log(`[printform]   >> Inserting ${numDummies} dummy rows before ${footerLabel}`);
    }
    const defaultDummyContent = `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;" class="prowitem_dummy"><tr><td style="height:${dummyHeight}px;">&nbsp;</td></tr></table>`;
    const dummyContent = this.config.customDummyRowItemContent || defaultDummyContent;
    for (let i = 0; i < numDummies; i++) {
      if (dummyContent) {
        let dummyNode = parseDummyRowContent(dummyContent);
        if (!dummyNode) {
          dummyNode = parseDummyRowContent(`<div style="height:${dummyHeight}px" class="prowitem_dummy">&nbsp;</div>`);
        }
        if (dummyNode) {
          if (!dummyNode.classList.contains("prowitem_dummy")) {
            dummyNode.classList.add("prowitem_dummy");
          }
          container.appendChild(dummyNode);
        }
      }
    }
    return this.measureContentHeight(container, pageContext.repeatingHeight);
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/pagination-render-special.js
function renderSpecialRow(formatter, context) {
  const {
    outputContainer,
    sections,
    heights,
    footerState,
    footerSpacerTemplate,
    logFn,
    pageContext,
    row,
    nextRow,
    index,
    rowHeight,
    footerHeight,
    comboHeight,
    currentHeight: startingHeight,
    hasFooterCombo,
    isPtacRow,
    isPaddtRow,
    baseClass,
    footerBaseClass
  } = context;
  const footerRow = hasFooterCombo ? nextRow : null;
  let currentHeight = startingHeight;
  const priorHeight = currentHeight;
  const isSubtotal = formatter.isSubtotalRow(row);
  const isFooter = formatter.isFooterRow(row);
  const footerLabel = hasFooterCombo ? "subtotal+footer" : isSubtotal ? "subtotal" : "footer";
  if (formatter.debug) {
    console.log(`[printform]   >> ${footerLabel.toUpperCase()} ROW detected at row[${index}]`);
  }
  if (row.classList.contains("tb_page_break_before")) {
    if (formatter.debug) {
      console.log(`[printform]   >> PAGE BREAK (tb_page_break_before) at row[${index}]`);
    }
    const skipDummyRowItems2 = formatter.shouldSkipDummyRowItemsForContext(pageContext);
    const nextSkipRowHeader = formatter.shouldSkipRowHeaderForRow(row);
    currentHeight = formatter.prepareNextPage(
      outputContainer,
      sections,
      logFn,
      pageContext.limit,
      currentHeight,
      footerState,
      footerSpacerTemplate,
      nextSkipRowHeader,
      skipDummyRowItems2,
      pageContext.repeatingHeight,
      formatter.getRowTableId(row)
    );
    formatter.refreshPageContextForRow(pageContext, row, heights, sections);
    const container2 = formatter.getCurrentPageContainer(outputContainer);
    pageContext.repeatingHeight = formatter.computeRepeatingHeightForPage(
      sections,
      heights,
      pageContext.skipRowHeader,
      pageContext.tableId
    );
    currentHeight = formatter.measureContentHeight(container2, pageContext.repeatingHeight);
  }
  const container = formatter.getCurrentPageContainer(outputContainer);
  const testClone = DomHelpers.appendRowItem(container, row, null, index, baseClass);
  const testFooterClone = footerRow ? DomHelpers.appendRowItem(container, footerRow, null, index + 1, footerBaseClass) : null;
  const testHeight = formatter.measureContentHeight(container, pageContext.repeatingHeight);
  if (testFooterClone && testFooterClone.parentNode === container) container.removeChild(testFooterClone);
  if (testClone && testClone.parentNode === container) container.removeChild(testClone);
  if (testHeight > pageContext.limit) {
    if (formatter.debug) {
      console.log(`[printform]   >> ${footerLabel.toUpperCase()} would overflow, moving to next page`);
    }
    const skipDummyRowItems2 = formatter.shouldSkipDummyRowItemsForContext(pageContext);
    const nextSkipRowHeader = formatter.shouldSkipRowHeaderForRow(row);
    currentHeight = formatter.prepareNextPage(
      outputContainer,
      sections,
      logFn,
      pageContext.limit,
      priorHeight,
      footerState,
      footerSpacerTemplate,
      nextSkipRowHeader,
      skipDummyRowItems2,
      pageContext.repeatingHeight,
      formatter.getRowTableId(row)
    );
    formatter.refreshPageContextForRow(pageContext, row, heights, sections);
    const nextContainer = formatter.getCurrentPageContainer(outputContainer);
    pageContext.repeatingHeight = formatter.computeRepeatingHeightForPage(
      sections,
      heights,
      pageContext.skipRowHeader,
      pageContext.tableId
    );
    currentHeight = formatter.measureContentHeight(nextContainer, pageContext.repeatingHeight);
  }
  const skipDummyRowItems = formatter.shouldSkipDummyRowItemsForContext(pageContext);
  if (!skipDummyRowItems) {
    const currentContainer = formatter.getCurrentPageContainer(outputContainer);
    const reservedHeight = footerRow ? comboHeight : rowHeight;
    currentHeight = formatter.insertFooterDummyRows(
      currentContainer,
      pageContext,
      currentHeight,
      reservedHeight,
      footerLabel
    );
  }
  const finalContainer = formatter.getCurrentPageContainer(outputContainer);
  DomHelpers.appendRowItem(finalContainer, row, null, index, baseClass);
  if (footerRow) DomHelpers.appendRowItem(finalContainer, footerRow, null, index + 1, footerBaseClass);
  if (logFn) logFn(`append ${footerLabel} ${index}`);
  currentHeight = formatter.measureContentHeight(finalContainer, pageContext.repeatingHeight);
  if (formatter.debug) {
    console.log(`[printform]   ${footerLabel} row[${index}] added, currentHeight=${currentHeight}px`);
  }
  const footerIsPtac = footerRow ? formatter.isPtacRow(footerRow) : false;
  const footerIsPaddt = footerRow ? formatter.isPaddtRow(footerRow) : false;
  if (!isPtacRow && !footerIsPtac) pageContext.isPtacPage = false;
  if (!isPaddtRow && !footerIsPaddt) pageContext.isPaddtPage = false;
  return { currentHeight, consumedNextRow: Boolean(hasFooterCombo) };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/pagination-render-rows.js
var ROW_HEIGHT_PREDICTION_SAFETY_MARGIN_PX = 50;
function renderRows(outputContainer, sections, heights, footerState, heightPerPage, footerSpacerTemplate, logFn) {
  let currentHeight = 0;
  const pageContext = this.initializePageContext(heightPerPage);
  if (this.debug) {
    console.log(`[printform] ===== renderRows START =====`);
    console.log(`[printform] Total rows: ${sections.rows.length}, heightPerPage: ${heightPerPage}px`);
  }
  const rowHeightCache = sections.rows.map((row) => DomHelpers.measureHeight(row));
  for (let index = 0; index < sections.rows.length; index++) {
    const row = sections.rows[index];
    const nextRow = sections.rows[index + 1];
    const rowHeight = rowHeightCache[index];
    const baseClass = this.getRowBaseClass(row);
    const isPtacRow = this.isPtacRow(row);
    const isPaddtRow = this.isPaddtRow(row);
    const isSubtotal = this.isSubtotalRow(row);
    const isFooter = this.isFooterRow(row);
    const hasFooterCombo = isSubtotal && nextRow && this.isFooterRow(nextRow);
    const footerRow = hasFooterCombo ? nextRow : null;
    const footerBaseClass = footerRow ? this.getRowBaseClass(footerRow) : null;
    const footerHeight = footerRow ? rowHeightCache[index + 1] : 0;
    const comboHeight = rowHeight + footerHeight;
    if (!rowHeight && (!hasFooterCombo || !footerHeight)) {
      DomHelpers.markAsProcessed(row, baseClass);
      if (hasFooterCombo) {
        DomHelpers.markAsProcessed(footerRow, footerBaseClass);
        index += 1;
      }
      continue;
    }
    if (currentHeight === 0) {
      this.refreshPageContextForRow(pageContext, row, heights, sections);
      const container2 = this.getCurrentPageContainer(outputContainer);
      this.ensureFirstPageSections(container2, sections, heights, logFn, pageContext.skipRowHeader, pageContext.tableId);
      pageContext.repeatingHeight = this.computeRepeatingHeightForPage(
        sections,
        heights,
        pageContext.skipRowHeader,
        pageContext.tableId
      );
      currentHeight = this.measureContentHeight(container2, pageContext.repeatingHeight);
      if (this.debug) {
        console.log(`[printform] Page ${this.currentPage} start: firstSectionHeight=${currentHeight}px, pageLimit=${pageContext.limit}px`);
      }
    }
    const activeTableId = this.getRowTableId(row);
    const activeHeader = this.ensureActiveTableHeader(
      this.getCurrentPageContainer(outputContainer),
      sections,
      logFn,
      activeTableId
    );
    if (activeHeader) {
      const activeContainer = this.getCurrentPageContainer(outputContainer);
      currentHeight = this.measureContentHeight(activeContainer, pageContext.repeatingHeight);
      const hasPriorRows = activeContainer.querySelector(".prowitem_processed, .ptac-rowitem_processed, .paddt-rowitem_processed");
      if (currentHeight > pageContext.limit && hasPriorRows) {
        activeContainer.removeChild(activeHeader);
        currentHeight = this.prepareNextPage(
          outputContainer,
          sections,
          logFn,
          pageContext.limit,
          currentHeight,
          footerState,
          footerSpacerTemplate,
          this.shouldSkipRowHeaderForRow(row),
          this.shouldSkipDummyRowItemsForContext(pageContext),
          pageContext.repeatingHeight,
          activeTableId
        );
        this.refreshPageContextForRow(pageContext, row, heights, sections);
        const nextContainer2 = this.getCurrentPageContainer(outputContainer);
        pageContext.repeatingHeight = this.computeRepeatingHeightForPage(
          sections,
          heights,
          pageContext.skipRowHeader,
          pageContext.tableId
        );
        currentHeight = this.measureContentHeight(nextContainer2, pageContext.repeatingHeight);
      }
    }
    DomHelpers.markAsProcessed(row, baseClass);
    if (footerRow) DomHelpers.markAsProcessed(footerRow, footerBaseClass);
    if (hasFooterCombo || isSubtotal || isFooter) {
      const result = renderSpecialRow(this, {
        outputContainer,
        sections,
        heights,
        footerState,
        footerSpacerTemplate,
        logFn,
        pageContext,
        row,
        nextRow,
        index,
        rowHeight,
        footerHeight,
        comboHeight,
        currentHeight,
        hasFooterCombo,
        isPtacRow,
        isPaddtRow,
        baseClass,
        footerBaseClass
      });
      currentHeight = result.currentHeight;
      if (result.consumedNextRow) index += 1;
      continue;
    }
    if (row.classList.contains("tb_page_break_before")) {
      if (this.debug) console.log(`[printform]   >> PAGE BREAK (tb_page_break_before) at row[${index}]`);
      currentHeight = this.prepareNextPage(
        outputContainer,
        sections,
        logFn,
        pageContext.limit,
        currentHeight,
        footerState,
        footerSpacerTemplate,
        this.shouldSkipRowHeaderForRow(row),
        this.shouldSkipDummyRowItemsForContext(pageContext),
        pageContext.repeatingHeight,
        this.getRowTableId(row)
      );
      this.refreshPageContextForRow(pageContext, row, heights, sections);
      const container2 = this.getCurrentPageContainer(outputContainer);
      pageContext.repeatingHeight = this.computeRepeatingHeightForPage(
        sections,
        heights,
        pageContext.skipRowHeader,
        pageContext.tableId
      );
      currentHeight = this.measureContentHeight(container2, pageContext.repeatingHeight);
      DomHelpers.appendRowItem(container2, row, null, index, baseClass);
      if (logFn) logFn(`append ${baseClass || "prowitem"} ${index}`);
      currentHeight = this.measureContentHeight(container2, pageContext.repeatingHeight);
      if (this.debug) console.log(`[printform] Page ${this.currentPage} start: currentHeight=${currentHeight}px, limit=${pageContext.limit}px`);
      if (!isPtacRow) pageContext.isPtacPage = false;
      if (!isPaddtRow) pageContext.isPaddtPage = false;
      continue;
    }
    const container = this.getCurrentPageContainer(outputContainer);
    const priorHeight = currentHeight;
    const predictedHeight = currentHeight + rowHeight;
    if (predictedHeight + ROW_HEIGHT_PREDICTION_SAFETY_MARGIN_PX <= pageContext.limit) {
      DomHelpers.appendRowItem(container, row, null, index, baseClass);
      if (this.debug) console.log(`[printform]   row[${index}] height=${rowHeight}px, predictedHeight=${predictedHeight}px, limit=${pageContext.limit}px (fast path, no reflow)`);
      if (logFn) logFn(`append ${baseClass || "prowitem"} ${index}`);
      currentHeight = predictedHeight;
      if (!isPtacRow) pageContext.isPtacPage = false;
      if (!isPaddtRow) pageContext.isPaddtPage = false;
      continue;
    }
    const clone = DomHelpers.appendRowItem(container, row, null, index, baseClass);
    const measuredHeight = this.measureContentHeight(container, pageContext.repeatingHeight);
    if (this.debug) console.log(`[printform]   row[${index}] height=${rowHeight}px, currentHeight=${measuredHeight}px, limit=${pageContext.limit}px`);
    if (measuredHeight <= pageContext.limit) {
      if (logFn) logFn(`append ${baseClass || "prowitem"} ${index}`);
      currentHeight = measuredHeight;
      if (!isPtacRow) pageContext.isPtacPage = false;
      if (!isPaddtRow) pageContext.isPaddtPage = false;
      continue;
    }
    if (clone && clone.parentNode === container) container.removeChild(clone);
    if (this.debug) console.log(`[printform]   >> PAGE BREAK (overflow) at row[${index}]`);
    currentHeight = this.prepareNextPage(
      outputContainer,
      sections,
      logFn,
      pageContext.limit,
      priorHeight,
      footerState,
      footerSpacerTemplate,
      this.shouldSkipRowHeaderForRow(row),
      this.shouldSkipDummyRowItemsForContext(pageContext),
      pageContext.repeatingHeight,
      this.getRowTableId(row)
    );
    this.refreshPageContextForRow(pageContext, row, heights, sections);
    const nextContainer = this.getCurrentPageContainer(outputContainer);
    pageContext.repeatingHeight = this.computeRepeatingHeightForPage(
      sections,
      heights,
      pageContext.skipRowHeader,
      pageContext.tableId
    );
    currentHeight = this.measureContentHeight(nextContainer, pageContext.repeatingHeight);
    DomHelpers.appendRowItem(nextContainer, row, null, index, baseClass);
    if (logFn) logFn(`append ${baseClass || "prowitem"} ${index}`);
    currentHeight = this.measureContentHeight(nextContainer, pageContext.repeatingHeight);
    if (this.debug) console.log(`[printform] Page ${this.currentPage} start: currentHeight=${currentHeight}px, limit=${pageContext.limit}px`);
    if (!isPtacRow) pageContext.isPtacPage = false;
    if (!isPaddtRow) pageContext.isPaddtPage = false;
  }
  if (this.debug) console.log(`[printform] ===== renderRows END (page ${this.currentPage}, finalHeight=${currentHeight}px) =====`);
  return {
    currentHeight,
    pageLimit: pageContext.limit,
    isPtacPage: pageContext.isPtacPage,
    isPaddtPage: pageContext.isPaddtPage,
    repeatingHeight: pageContext.repeatingHeight
  };
}
function renderEmptyDocument(outputContainer, sections, heights, heightPerPage, logFn) {
  const container = this.getCurrentPageContainer(outputContainer);
  if (this.debug) console.log(`[printform] ===== renderEmptyDocument START =====`);
  this.ensureFirstPageSections(container, sections, heights, logFn, false);
  const repeatingHeight = this.computeRepeatingHeightForPage(sections, heights, false);
  const currentHeight = this.measureContentHeight(container, repeatingHeight);
  if (this.debug) {
    console.log(`[printform] Empty document currentHeight=${currentHeight}px, pageLimit=${heightPerPage}px`);
    console.log(`[printform] ===== renderEmptyDocument END =====`);
  }
  return { currentHeight, pageLimit: heightPerPage, isPtacPage: false, isPaddtPage: false, repeatingHeight };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/pagination-render.js
function attachPaginationRenderMethods(FormatterClass) {
  FormatterClass.prototype.renderRows = renderRows;
  FormatterClass.prototype.renderEmptyDocument = renderEmptyDocument;
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/pagination-spacing.js
function attachPaginationSpacingMethods(FormatterClass) {
  FormatterClass.prototype.prepareNextPage = function prepareNextPage(outputContainer, sections, logFn, pageLimit, currentHeight, footerState, spacerTemplate, skipRowHeader, skipDummyRowItems, repeatingHeight, tableId = "default") {
    const container = this.getCurrentPageContainer(outputContainer);
    const filledHeight = this.applyRemainderSpacing(
      container,
      pageLimit,
      currentHeight,
      footerState,
      spacerTemplate,
      {
        skipDummyRowItems,
        repeatingHeight
      }
    );
    this.appendRepeatingFooters(container, sections, logFn);
    this.currentPage += 1;
    this.currentPageContainer = null;
    this.createNewLogicalPage(outputContainer);
    const nextContainer = this.getCurrentPageContainer(outputContainer);
    this.appendRepeatingSections(nextContainer, sections, logFn, skipRowHeader, tableId);
    return filledHeight;
  };
  FormatterClass.prototype.applyRemainderSpacing = function applyRemainderSpacing(container, heightPerPage, currentHeight, footerState, spacerTemplate, options) {
    const skipDummyRowItems = options && options.skipDummyRowItems;
    const repeatingHeight = options && Number.isFinite(options.repeatingHeight) ? options.repeatingHeight : null;
    const useCurrentHeight = options && options.useCurrentHeight === true;
    let workingHeight = normalizeHeight(currentHeight);
    if (repeatingHeight !== null && !useCurrentHeight) {
      const measuredTotal = DomHelpers.measureHeightRaw(container);
      workingHeight = normalizeHeight(measuredTotal - repeatingHeight);
    }
    if (this.debug) {
      console.log(`[printform] ----- applyRemainderSpacing (page ${this.currentPage}) -----`);
      console.log(`[printform]   heightPerPage: ${heightPerPage}px, currentHeight: ${currentHeight}px`);
      console.log(`[printform]   skipDummyRowItems: ${skipDummyRowItems}`);
    }
    if (!skipDummyRowItems) {
      workingHeight = applyDummyRowItemsStep(this.config, container, heightPerPage, workingHeight, this.debug);
    }
    workingHeight = applyDummyRowStep(this.config, container, heightPerPage, workingHeight, this.debug);
    const spacerState = applyFooterSpacerWithDummyStep(
      this.config,
      container,
      heightPerPage,
      workingHeight,
      skipDummyRowItems,
      this.debug
    );
    workingHeight = spacerState.currentHeight;
    if (!spacerState.skipFooterSpacer) {
      applyFooterSpacerStep(
        this.config,
        container,
        heightPerPage,
        workingHeight,
        footerState,
        spacerTemplate,
        this.debug
      );
    }
    if (this.debug) {
      console.log(`[printform]   finalHeight after spacing: ${workingHeight}px`);
      console.log(`[printform] -----------------------------------------`);
    }
    return normalizeHeight(workingHeight);
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/pagination-finalize.js
function attachPaginationFinalizeMethods(FormatterClass) {
  if (!FormatterClass.prototype.maxRepeatingRowHeaderHeight) attachRowHeaderPolicyMethods(FormatterClass);
  FormatterClass.prototype.computeHeightPerPage = function computeHeightPerPage(sections, heights) {
    let available = this.config.papersizeHeight;
    if (this.debug) {
      console.log(`[printform] ===== computeHeightPerPage =====`);
      console.log(`[printform] papersizeHeight (config): ${this.config.papersizeHeight}px`);
      console.log(`[printform] papersizeWidth (config): ${this.config.papersizeWidth}px`);
    }
    if (this.config.repeatHeader && sections.header) {
      if (this.debug) {
        console.log(`[printform]   - repeatHeader: ${heights.header}px`);
      }
      available -= heights.header;
    }
    sections.docInfos.forEach((docInfo) => {
      if (this.config[docInfo.repeatFlag]) {
        const h = heights.docInfos[docInfo.key] || 0;
        if (this.debug) {
          console.log(`[printform]   - repeat ${docInfo.className}: ${h}px`);
        }
        available -= h;
      }
    });
    const maxRowHeaderHeight = this.maxRepeatingRowHeaderHeight(sections, heights);
    if (maxRowHeaderHeight > 0) {
      if (this.debug) {
        console.log(`[printform]   - repeatRowheader (max active table): ${maxRowHeaderHeight}px`);
      }
      available -= maxRowHeaderHeight;
    }
    sections.footerVariants.forEach((footer) => {
      if (this.config[footer.repeatFlag]) {
        const h = heights.footerVariants[footer.key] || 0;
        if (this.debug) {
          console.log(`[printform]   - repeat ${footer.className}: ${h}px`);
        }
        available -= h;
      }
    });
    if (this.config.repeatFooterLogo && sections.footerLogo) {
      if (this.debug) {
        console.log(`[printform]   - repeatFooterLogo: ${heights.footerLogo}px`);
      }
      available -= heights.footerLogo;
    }
    if (this.config.repeatFooterPagenum && sections.footerPagenum) {
      const h = heights.footerPagenum || 0;
      if (this.debug) {
        console.log(`[printform]   - repeatFooterPagenum: ${h}px`);
      }
      available -= h;
    }
    if (this.debug) {
      console.log(`[printform] heightPerPage (available for content): ${Math.max(0, available)}px`);
      console.log(`[printform] ================================`);
    }
    return Math.max(0, available);
  };
  FormatterClass.prototype.computeFooterState = function computeFooterState(sections, heights) {
    const footerLogoHeight = heights.footerLogo || 0;
    const footerPagenumHeight = heights.footerPagenum || 0;
    const totalFooterHeight = sections.footerVariants.reduce((sum, footer) => {
      const height = heights.footerVariants[footer.key] || 0;
      return sum + height;
    }, 0);
    const totalFinal = totalFooterHeight + footerLogoHeight + footerPagenumHeight;
    const repeatingFooterHeight = sections.footerVariants.reduce((sum, footer) => {
      const height = heights.footerVariants[footer.key] || 0;
      return this.config[footer.repeatFlag] ? sum + height : sum;
    }, 0);
    let repeating = repeatingFooterHeight;
    if (this.config.repeatFooterLogo) {
      repeating += footerLogoHeight;
    }
    if (this.config.repeatFooterPagenum) {
      repeating += footerPagenumHeight;
    }
    const nonRepeating = Math.max(0, totalFinal - repeating);
    return {
      totalFinal,
      repeating,
      nonRepeating
    };
  };
  FormatterClass.prototype.finalizeDocument = function finalizeDocument(outputContainer, sections, heights, footerState, defaultHeightPerPage, renderState, spacerTemplate, logFn) {
    const baseHeight = renderState ? renderState.currentHeight : 0;
    const lastPageLimit = renderState && renderState.pageLimit ? renderState.pageLimit : defaultHeightPerPage;
    const repeatingHeight = renderState && Number.isFinite(renderState.repeatingHeight) ? renderState.repeatingHeight : 0;
    const skipDummyRowItems = Boolean(
      renderState && (renderState.isPtacPage && !this.config.insertPtacDummyRowItems || renderState.isPaddtPage && !(this.paddtConfig && this.paddtConfig.insertPaddtDummyRowItems))
    );
    const allowance = footerState.totalFinal - footerState.repeating;
    const heightWithFinalFooters = baseHeight + allowance;
    if (heightWithFinalFooters <= lastPageLimit) {
      const container2 = this.getCurrentPageContainer(outputContainer);
      this.applyRemainderSpacing(
        container2,
        lastPageLimit,
        heightWithFinalFooters,
        footerState,
        spacerTemplate,
        {
          skipDummyRowItems,
          repeatingHeight,
          useCurrentHeight: true
        }
      );
      this.appendFinalFooters(container2, sections, logFn);
      return;
    }
    this.prepareNextPage(
      outputContainer,
      sections,
      logFn,
      lastPageLimit,
      baseHeight,
      footerState,
      spacerTemplate,
      true,
      skipDummyRowItems,
      repeatingHeight,
      "default"
    );
    const finalPageStartHeight = allowance;
    const container = this.getCurrentPageContainer(outputContainer);
    const nextRepeatingHeight = this.computeRepeatingHeightForPage(sections, heights, true, "default");
    this.applyRemainderSpacing(
      container,
      defaultHeightPerPage,
      finalPageStartHeight,
      footerState,
      spacerTemplate,
      {
        repeatingHeight: nextRepeatingHeight,
        useCurrentHeight: true
      }
    );
    this.appendFinalFooters(container, sections, logFn);
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/debug.js
function safeSerialize(value) {
  if (value === null) return "null";
  if (value === void 0) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Error) {
    const name = value.name || "Error";
    const message = value.message || "";
    return message ? `${name}: ${message}` : name;
  }
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}
function formatArgs(args) {
  return Array.from(args).map(safeSerialize).join(" ");
}
function ensureDebugPanelStyle(doc) {
  if (!doc || !doc.head) return;
  const existing = doc.getElementById("printform-debug-panel-style");
  if (existing) return;
  const style = doc.createElement("style");
  style.id = "printform-debug-panel-style";
  style.textContent = `
    [data-printform-debug-panel="true"]{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;border:1px solid #ddd;background:#fafafa;color:#111;padding:12px;margin:12px 0;max-width:100%;overflow:auto}
    [data-printform-debug-panel="true"] .printform-debug-title{font-weight:700;margin-bottom:8px}
    [data-printform-debug-panel="true"] .printform-debug-meta{font-size:12px;opacity:.85;line-height:1.4;margin-bottom:8px;white-space:pre-wrap}
    [data-printform-debug-panel="true"] .printform-debug-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
    [data-printform-debug-panel="true"] button{font:inherit;font-size:12px;padding:6px 10px;border:1px solid #bbb;background:#fff;border-radius:6px}
    [data-printform-debug-panel="true"] button:active{transform:translateY(1px)}
    [data-printform-debug-panel="true"] .printform-debug-status{font-size:12px;opacity:.8}
    [data-printform-debug-panel="true"] pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.35}
    @media print{[data-printform-debug-panel="true"]{display:none!important}}
  `.trim();
  doc.head.appendChild(style);
}
async function copyTextToClipboard(view, text) {
  if (!view) return { ok: false, method: "none" };
  const nav = view.navigator;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      await nav.clipboard.writeText(text);
      return { ok: true, method: "navigator.clipboard.writeText" };
    } catch {
    }
  }
  const doc = view.document;
  if (!doc) return { ok: false, method: "none" };
  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  doc.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const ok = doc.execCommand && doc.execCommand("copy");
    return { ok: Boolean(ok), method: "document.execCommand(copy)" };
  } catch {
    return { ok: false, method: "document.execCommand(copy)" };
  } finally {
    doc.body.removeChild(textarea);
  }
}
function formatConfigSummary(config) {
  if (!config) return "";
  const pick = (key) => config && Object.prototype.hasOwnProperty.call(config, key) ? config[key] : void 0;
  const parts = [
    `papersizeWidth=${pick("papersizeWidth")}`,
    `papersizeHeight=${pick("papersizeHeight")}`,
    `paperSize=${pick("paperSize")}`,
    `orientation=${pick("orientation")}`,
    `dpi=${pick("dpi")}`,
    `nUp=${pick("nUp")}`,
    `repeatHeader=${pick("repeatHeader")}`,
    `repeatRowheader=${pick("repeatRowheader")}`,
    `repeatFooterLogo=${pick("repeatFooterLogo")}`,
    `repeatFooterPagenum=${pick("repeatFooterPagenum")}`
  ];
  return parts.join(", ");
}
function createPrintformDebugSession({ enabled, formEl, config }) {
  const doc = formEl && formEl.ownerDocument ? formEl.ownerDocument : null;
  const view = doc && doc.defaultView ? doc.defaultView : null;
  const startMs = Date.now();
  const lines = [];
  let installed = false;
  let originals = null;
  let removeErrorHandlers = null;
  const pushLine = (level, args) => {
    const delta = Date.now() - startMs;
    const message = formatArgs(args);
    lines.push(`+${delta}ms [${level}] ${message}`);
  };
  const addEventLine = (level, message) => {
    const delta = Date.now() - startMs;
    lines.push(`+${delta}ms [${level}] ${message}`);
  };
  const install = () => {
    if (!enabled || installed || !view || !view.console) return;
    installed = true;
    const con = view.console;
    originals = {
      log: con.log,
      info: con.info,
      warn: con.warn,
      error: con.error
    };
    const wrap = (level) => function wrappedConsoleMethod(...args) {
      pushLine(level, args);
      const original = originals && originals[level];
      if (typeof original === "function") {
        try {
          original.apply(con, args);
        } catch {
        }
      }
    };
    try {
      con.log = wrap("log");
      con.info = wrap("info");
      con.warn = wrap("warn");
      con.error = wrap("error");
    } catch {
      installed = false;
      originals = null;
      return;
    }
    const onError = (event) => {
      const message = event && event.message ? event.message : "window.error";
      addEventLine("error", message);
    };
    const onUnhandledRejection = (event) => {
      const reason = event && event.reason ? safeSerialize(event.reason) : "unhandledrejection";
      addEventLine("error", `unhandledrejection: ${reason}`);
    };
    if (typeof view.addEventListener === "function" && typeof view.removeEventListener === "function") {
      view.addEventListener("error", onError);
      view.addEventListener("unhandledrejection", onUnhandledRejection);
      removeErrorHandlers = () => {
        view.removeEventListener("error", onError);
        view.removeEventListener("unhandledrejection", onUnhandledRejection);
      };
    }
    try {
      con.log("[printform] ===== DEBUG SESSION START =====");
      con.log(`[printform] time: ${new Date(startMs).toISOString()}`);
      if (view.navigator && view.navigator.userAgent) {
        con.log(`[printform] userAgent: ${view.navigator.userAgent}`);
      }
      if (typeof view.devicePixelRatio === "number") {
        con.log(`[printform] devicePixelRatio: ${view.devicePixelRatio}`);
      }
      if (typeof view.innerWidth === "number" && typeof view.innerHeight === "number") {
        con.log(`[printform] viewport: ${view.innerWidth}x${view.innerHeight}`);
      }
      if (view.visualViewport) {
        con.log(`[printform] visualViewport: ${safeSerialize({ width: view.visualViewport.width, height: view.visualViewport.height, scale: view.visualViewport.scale })}`);
      }
      con.log(`[printform] config: ${formatConfigSummary(config)}`);
    } catch {
    }
  };
  const uninstall = () => {
    if (!installed || !view || !view.console) return;
    const con = view.console;
    if (removeErrorHandlers) {
      try {
        removeErrorHandlers();
      } catch {
      }
    }
    if (originals) {
      con.log = originals.log;
      con.info = originals.info;
      con.warn = originals.warn;
      con.error = originals.error;
    }
  };
  const markEnd = (details) => {
    if (!enabled || !installed || !view || !view.console) return;
    const con = view.console;
    try {
      con.log("[printform] ===== DEBUG SESSION END =====");
      if (details && typeof details === "object") {
        con.log(`[printform] debugSummary: ${safeSerialize(details)}`);
      }
    } catch {
    }
  };
  const getText = () => lines.join("\n");
  const appendPanel = (outputContainer, details) => {
    if (!enabled || !doc || !outputContainer) return;
    ensureDebugPanelStyle(doc);
    const panel = doc.createElement("div");
    panel.setAttribute("data-printform-debug-panel", "true");
    const title = doc.createElement("div");
    title.className = "printform-debug-title";
    title.textContent = "PrintForm Debug (data-debug=y)";
    panel.appendChild(title);
    const meta = doc.createElement("div");
    meta.className = "printform-debug-meta";
    const pageCount = details && Number.isFinite(details.pageCount) ? details.pageCount : null;
    const formId = formEl && formEl.id ? `#${formEl.id}` : "";
    const formClass = formEl && typeof formEl.className === "string" ? `.${formEl.className.split(/\s+/).filter(Boolean).join(".")}` : "";
    const formLabel = formId || formClass ? `${formId}${formClass}` : "(no id/class)";
    meta.textContent = [
      `form: ${formLabel}`,
      pageCount !== null ? `pages: ${pageCount}` : null,
      `config: ${formatConfigSummary(config)}`
    ].filter(Boolean).join("\n");
    panel.appendChild(meta);
    const actions = doc.createElement("div");
    actions.className = "printform-debug-actions";
    const copyButton = doc.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy all logs";
    actions.appendChild(copyButton);
    const status = doc.createElement("span");
    status.className = "printform-debug-status";
    status.textContent = "";
    actions.appendChild(status);
    panel.appendChild(actions);
    const pre = doc.createElement("pre");
    pre.textContent = getText();
    panel.appendChild(pre);
    copyButton.addEventListener("click", async () => {
      const text = getText();
      const result = await copyTextToClipboard(view, text);
      status.textContent = result.ok ? `copied (${result.method})` : `copy failed (${result.method})`;
    });
    outputContainer.appendChild(panel);
  };
  return {
    install,
    markEnd,
    uninstall,
    appendPanel,
    getText
  };
}

// ../../../../../../../private/tmp/shop-printform-source/src/printform/formatter/PrintFormFormatter.js
var PrintFormFormatter = class {
  constructor(formEl, config) {
    this.formEl = formEl;
    this.config = config;
    this.debug = Boolean(config.debug);
    this.nUp = Math.max(1, Math.floor(Number(config.nUp || 1)));
    this.showLogicalPageNumber = config.showLogicalPageNumber !== false;
    this.showPhysicalPageNumber = Boolean(config.showPhysicalPageNumber);
    this.paddtConfig = getPaddtConfig(formEl, {});
    this.paddtDebug = Boolean(this.paddtConfig.paddtDebug);
    this.currentPage = 1;
    this.currentPhysicalPage = 0;
    this.pagesInCurrentPhysical = 0;
    this.currentPhysicalWrapper = null;
    this.currentPageContainer = null;
    this.logicalPageNumberClones = [];
    this.physicalPageNumberClones = [];
    this.logicalPageToPhysicalPage = [];
    if (this.debug) {
      console.log(`[printform] ===== PrintFormFormatter initialized =====`);
      console.log(`[printform] debug mode: ON`);
      console.log(`[printform] config.debug raw value: ${config.debug}`);
    }
  }
  log(message) {
    if (this.debug) {
      console.log(`[printform] ${message}`);
    }
  }
  format() {
    const debugSession = createPrintformDebugSession({
      enabled: this.debug,
      formEl: this.formEl,
      config: this.config
    });
    debugSession.install();
    const logFn = this.debug ? this.log.bind(this) : null;
    try {
      const container = this.initializeOutputContainer();
      this.ensureCurrentPageContainer(container);
      const sections = this.collectSections();
      const heights = this.measureSections(sections);
      const footerSpacerTemplate = this.createFooterSpacerTemplate();
      this.markSectionsProcessed(sections);
      const footerState = this.computeFooterState(sections, heights);
      const heightPerPage = this.computeHeightPerPage(sections, heights);
      const renderState = sections.rows.length ? this.renderRows(
        container,
        sections,
        heights,
        footerState,
        heightPerPage,
        footerSpacerTemplate,
        logFn
      ) : this.renderEmptyDocument(
        container,
        sections,
        heights,
        heightPerPage,
        logFn
      );
      this.finalizeDocument(
        container,
        sections,
        heights,
        footerState,
        heightPerPage,
        renderState,
        footerSpacerTemplate,
        logFn
      );
      if (this.paddtRows && this.paddtRows.length) {
        this.currentPage += 1;
        this.currentPageContainer = null;
        this.initializePhysicalWrapper(container);
        this.createNewLogicalPage(container);
        var paddtDocinfoFlags = {
          docInfo: this.paddtConfig.repeatPaddtDocinfo,
          docInfo002: this.paddtConfig.repeatPaddtDocinfo002,
          docInfo003: this.paddtConfig.repeatPaddtDocinfo003,
          docInfo004: this.paddtConfig.repeatPaddtDocinfo004,
          docInfo005: this.paddtConfig.repeatPaddtDocinfo005
        };
        var paddtDocInfos = sections.docInfos.filter(function(di) {
          var flag2 = paddtDocinfoFlags[di.key];
          return flag2 === void 0 ? true : !!flag2;
        });
        const paddtSections = {
          header: sections.header,
          docInfos: paddtDocInfos,
          rowHeader: sections.rowHeader,
          // 不包含业务 footer（如 pfooter/pfooter002...），仅保留 logo 与页码
          footerVariants: [],
          footerLogo: sections.footerLogo,
          footerPagenum: sections.footerPagenum,
          rowHeaders: sections.rowHeaders,
          rowHeadersById: sections.rowHeadersById,
          rows: this.paddtRows
        };
        const paddtFooterState = this.computeFooterState(paddtSections, heights);
        const paddtHeightPerPage = this.computeHeightPerPage(paddtSections, heights);
        const paddtRenderState = this.renderRows(
          container,
          paddtSections,
          heights,
          paddtFooterState,
          paddtHeightPerPage,
          footerSpacerTemplate,
          logFn
        );
        this.finalizeDocument(
          container,
          paddtSections,
          heights,
          paddtFooterState,
          paddtHeightPerPage,
          paddtRenderState,
          footerSpacerTemplate,
          logFn
        );
      }
      this.updatePageNumberTotals();
      const allPages = container.querySelectorAll(".printform_page");
      if (this.debug) {
        console.log(`[printform] Finalizing heights for ${allPages.length} pages...`);
      }
      allPages.forEach((page, index) => {
        this.finalizePageHeight(page);
        if (this.debug) {
          const heightStyle = page.style.height || "(auto)";
          console.log(`[printform]   Page ${index + 1}: height style = ${heightStyle}`);
        }
      });
      debugSession.markEnd({ pageCount: allPages.length });
      debugSession.appendPanel(container, { pageCount: allPages.length });
      container.classList.remove("printform_formatter");
      container.classList.add("printform_formatter_processed");
      this.formEl.remove();
      return container;
    } finally {
      debugSession.uninstall();
    }
  }
};
attachPageMethods(PrintFormFormatter);
attachSectionMethods(PrintFormFormatter);
attachRowTypeMethods(PrintFormFormatter);
attachRowHeaderPolicyMethods(PrintFormFormatter);
attachPaddtSegmentMethods(PrintFormFormatter);
attachPtacSegmentMethods(PrintFormFormatter);
attachRenderingMethods(PrintFormFormatter);
attachPaginationContextMethods(PrintFormFormatter);
attachPaginationDummyMethods(PrintFormFormatter);
attachPaginationRenderMethods(PrintFormFormatter);
attachPaginationSpacingMethods(PrintFormFormatter);
attachPaginationFinalizeMethods(PrintFormFormatter);

// ../../../../../../../private/tmp/shop-printform-source/src/version.js
var PRINTFORM_VERSION = "1.0.0";

// ../../../../../../../private/tmp/shop-printform-source/src/printform.js
function isMobileDevice() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}
function getDeviceDelay() {
  return isMobileDevice() ? 50 : 1;
}
function withDividerClassAppend(globalScope2, classAppend, fn) {
  const prior = globalScope2.__printFormDividerClassAppend;
  globalScope2.__printFormDividerClassAppend = typeof classAppend === "string" ? classAppend : "";
  try {
    return fn();
  } finally {
    if (prior === void 0) {
      delete globalScope2.__printFormDividerClassAppend;
    } else {
      globalScope2.__printFormDividerClassAppend = prior;
    }
  }
}
function pauseInMilliseconds(time) {
  return new Promise((resolve, reject) => {
    if (typeof time === "number" && time > 0) {
      setTimeout(resolve, time);
    } else {
      reject(new Error("Invalid time value"));
    }
  });
}
async function formatAllPrintForms(overrides = {}) {
  const globalScope2 = typeof window !== "undefined" ? window : globalThis;
  if (globalScope2.__printFormProcessing) {
    return;
  }
  if (!overrides.force && globalScope2.__printFormProcessed) {
    return;
  }
  globalScope2.__printFormProcessing = true;
  try {
    const doc = globalScope2.document;
    if (!doc) return;
    const forms = Array.from(doc.querySelectorAll(".printform"));
    for (let index = 0; index < forms.length; index += 1) {
      const formEl = forms[index];
      const perFormOverrides = { ...overrides };
      if (perFormOverrides.divPageBreakBeforeClassAppend === void 0 && formEl && formEl.dataset) {
        const datasetValue = formEl.dataset.divPageBreakBeforeClassAppend;
        if (typeof datasetValue === "string" && datasetValue.trim()) {
          perFormOverrides.divPageBreakBeforeClassAppend = datasetValue.trim();
        }
      }
      const dividerClassAppend = perFormOverrides.divPageBreakBeforeClassAppend;
      const config = getPrintformConfig(formEl, perFormOverrides);
      try {
        await pauseInMilliseconds(getDeviceDelay());
      } catch (error) {
        console.error("pauseInMilliseconds error", error);
      }
      try {
        const formatted = withDividerClassAppend(globalScope2, dividerClassAppend, () => {
          const formatter = new PrintFormFormatter(formEl, config);
          return formatter.format();
        });
        if (index > 0 && formatted && formatted.parentNode) {
          formatted.parentNode.insertBefore(DomHelpers.createPageBreakDivider(dividerClassAppend), formatted);
        }
      } catch (error) {
        console.error("printform format error", error);
      }
    }
    globalScope2.__printFormProcessed = true;
  } finally {
    globalScope2.__printFormProcessing = false;
  }
}
function formatSinglePrintForm(formEl, overrides = {}) {
  const globalScope2 = typeof window !== "undefined" ? window : globalThis;
  const perFormOverrides = { ...overrides };
  if (perFormOverrides.divPageBreakBeforeClassAppend === void 0 && formEl && formEl.dataset) {
    const datasetValue = formEl.dataset.divPageBreakBeforeClassAppend;
    if (typeof datasetValue === "string" && datasetValue.trim()) {
      perFormOverrides.divPageBreakBeforeClassAppend = datasetValue.trim();
    }
  }
  const dividerClassAppend = perFormOverrides.divPageBreakBeforeClassAppend;
  const config = getPrintformConfig(formEl, perFormOverrides);
  return withDividerClassAppend(globalScope2, dividerClassAppend, () => {
    const formatter = new PrintFormFormatter(formEl, config);
    return formatter.format();
  });
}
var api = {
  version: PRINTFORM_VERSION,
  formatAll: formatAllPrintForms,
  format: formatSinglePrintForm,
  DEFAULT_CONFIG,
  DEFAULT_PADDT_CONFIG
};
var globalScope = typeof window !== "undefined" ? window : null;
if (globalScope) {
  if (globalScope.__printFormScriptLoaded__) {
    globalScope.PrintForm = globalScope.PrintForm || api;
  } else {
    globalScope.__printFormScriptLoaded__ = true;
    globalScope.PrintForm = globalScope.PrintForm || {};
    Object.assign(globalScope.PrintForm, api);
    const doc = globalScope.document;
    if (doc && doc.addEventListener) {
      let ensureReadyAndFormat = function() {
        const isMobile = isMobileDevice();
        const delay = isMobile ? 150 : 50;
        if (doc.readyState === "complete") {
          setTimeout(() => {
            formatAllPrintForms();
          }, delay);
        } else {
          globalScope.addEventListener("load", () => {
            setTimeout(() => {
              formatAllPrintForms();
            }, delay);
          });
        }
      };
      if (doc.readyState === "loading") {
        doc.addEventListener("DOMContentLoaded", ensureReadyAndFormat);
      } else {
        ensureReadyAndFormat();
      }
    }
  }
}
var printform_default = api;
export {
  printform_default as default
};
