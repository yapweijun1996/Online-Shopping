import { salesTrend, topProducts, inventoryRisk, ANALYTICS_COVERAGE_NOTE } from '../analytics.js';
import { SALES_CURRENCIES, SALES_DEFINITION_VERSION, SALES_STATUSES, SALES_TIME_ZONE } from '../sales-definition.js';
import { RESERVATION_HOURS } from '../stock-reservation.js';
import { valid } from './tools.js';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (minimum, maximum, extra = {}) => ({ type: 'string', minLength: minimum, maxLength: maximum, ...extra });
const int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items, maxItems) => ({ type: 'array', minItems: 0, maxItems, items });
const enumeration = values => text(1, 64, { enum: [...values] });
const bool = { type: 'boolean' };
const constant = value => text(value.length, value.length, { const: value });
const currency = enumeration(SALES_CURRENCIES);
const date = text(10, 10, { pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const instant = text(24, 24);
const uuid = text(36, 36, { pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const pageInput = { limit: int(1, 100), offset: int(0, 10000) };
const rangeInput = { from: date, toExclusive: date };
const groups = enumeration(['day', 'week', 'month']), topGroups = enumeration(['product', 'category']), sorts = enumeration(['quantity', 'value']);
const modes = enumeration(['low', 'slow', 'either', 'all']);
const sales = object({ currency, orders: int(), totalMinor: int() });
const units = object({ currency, quantity: int(), totalMinor: int() });
const coverage = object({ databaseComplete: { type: 'boolean', const: true }, historyComplete: { type: 'boolean', const: false }, pageComplete: bool, note: constant(ANALYTICS_COVERAGE_NOTE) });
const metadata = { timeZone: constant(SALES_TIME_ZONE), definitionVersion: constant(SALES_DEFINITION_VERSION), asOf: instant,
  acceptedStatuses: { type: 'array', minItems: SALES_STATUSES.length, maxItems: SALES_STATUSES.length, items: enumeration(SALES_STATUSES) } };
const pagination = { nextOffset: nullable(int(0, 10000)), paginationCapped: bool, coverage };
const comparison = nullable(object({ from: date, toExclusive: date, totals: array(sales, 2), delta: array(object({ currency, orders: int(-Number.MAX_SAFE_INTEGER), totalMinor: int(-Number.MAX_SAFE_INTEGER) }), 2) }));
const trendInput = object({ ...rangeInput, groupBy: groups, currency, comparePrevious: bool, ...pageInput }, ['from', 'toExclusive']);
const trendOutput = object({ ...metadata, metricName: constant('accepted_order_value'), dateRange: object(rangeInput), currency: nullable(currency), filters: object({ currency: nullable(currency), groupBy: groups, comparePrevious: bool }), groupBy: groups, weekStartsOn: constant('MONDAY'), totals: array(sales, 2), comparison,
  items: array(object({ from: date, toExclusive: date, sales: array(sales, 2) }), 100), ...pagination });
const topInput = object({ ...rangeInput, groupBy: topGroups, currency, sortBy: sorts, ...pageInput }, ['from', 'toExclusive']);
const topOutput = object({ ...metadata, metricName: constant('accepted_item_value'), dateRange: object(rangeInput), currency: nullable(currency), filters: object({ currency: nullable(currency), groupBy: topGroups, sortBy: sorts }), groupBy: topGroups, sortBy: sorts,
  attribution: constant('CURRENT_PRODUCT_AND_CATEGORY'), historicalCategoryAvailable: { type: 'boolean', const: false }, totals: array(units, 2),
  items: array(object({ productId: nullable(uuid), sku: nullable(text(0, 40)), name: nullable(text(0, 120)), categoryCode: text(0, 80), currency, quantity: int(), totalMinor: int() }), 100), ...pagination });
const inventoryInput = object({ threshold: int(0, 1000000), slowDays: int(1, 366), mode: modes, activeOnly: bool, ...pageInput }, []);
const inventoryOutput = object({ ...metadata, metricName: constant('inventory_risk'), dateRange: object({ from: instant, toExclusive: instant }), currency: { type: 'null' }, filters: object({ threshold: int(0, 1000000), slowDays: int(1, 366), mode: modes, activeOnly: bool }),
  threshold: int(0, 1000000), slowDays: int(1, 366), mode: modes, activeOnly: bool, totals: object({ scannedProducts: int(0, 10000), matchedProducts: int(0, 10000), matchedTracked: int(0, 10000), matchedUnlimited: int(0, 10000), matchedLowStock: int(0, 10000), matchedSlowMoving: int(0, 10000), matchedUnknownSlow: int(0, 10000) }),
  reservationHours: int(RESERVATION_HOURS, RESERVATION_HOURS), lookbackFrom: instant, lookbackToExclusive: instant, slowDefinition: constant('ZERO_ACCEPTED_UNITS_AND_OLD_ENOUGH'),
  items: array(object({ productId: uuid, sku: text(0, 40), name: text(0, 120), categoryCode: text(0, 80), active: bool, stockQuantity: nullable(int()), reservedQuantity: int(), availableQuantity: nullable(int()),
    reservationShortfall: int(), lowStock: bool, slowMoving: nullable(bool), acceptedQuantityInPeriod: int() }), 100), ...pagination });
function tool(name, inputSchema, outputSchema, query) {
  return { kind: 'read', name, scope: 'analytics.extended', capability: 'figures.read', inputSchema, outputSchema,
    async read(read, args) {
      const value = await query(read, args);
      if (!valid(value, outputSchema)) throw new TypeError('Invalid analytics result.');
      return value;
    } };
}
// Importing contracts registers nothing; default factory wiring is a separate checkpoint.
export const analyticsSalesTrendTool = () => tool('analytics.sales_trend', trendInput, trendOutput, salesTrend);
export const analyticsTopProductsTool = () => tool('analytics.top_products', topInput, topOutput, topProducts);
export const analyticsInventoryRiskTool = () => tool('analytics.inventory_risk', inventoryInput, inventoryOutput, inventoryRisk);
