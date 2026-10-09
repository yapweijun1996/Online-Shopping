// Who may do what (MULTI_TENANT_PRODUCTION_PLAN.md, "Shop roles"). The server checks these on every seller route; the UI
// only hides what a role cannot use. A role is read from the account on every request, so a change applies at once.
export const ROLES = ['OWNER', 'MANAGER', 'STAFF'];

const CAPABILITIES = {
  'orders.fulfil': ['OWNER', 'MANAGER', 'STAFF'],   // view orders, ship and deliver them, print documents
  'orders.decide': ['OWNER', 'MANAGER'],            // confirm, reject, cancel
  'catalog.write': ['OWNER', 'MANAGER'],            // products, prices, stock, categories, options
  'messages.act': ['OWNER', 'MANAGER'],             // resolve WhatsApp messages that need attention
  'figures.read': ['OWNER', 'MANAGER'],             // sales totals
  'settings.write': ['OWNER'],                      // shop setup, company settings, WhatsApp connection, demo reset
  'staff.manage': ['OWNER'],                        // accounts
  'data.erase': ['OWNER'],
  'data.export': ['OWNER'],
};

export const can = (role, capability) => Boolean(CAPABILITIES[capability]?.includes(role));
export const capabilitiesOf = (role) => Object.keys(CAPABILITIES).filter((capability) => can(role, capability));
