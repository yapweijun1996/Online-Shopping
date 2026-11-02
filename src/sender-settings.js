// Fixed identifiers shared by migrations, settings validation and shipping exports.
export const senderFields = {
  senderName: ['sender_name', 120], senderPhone: ['sender_phone', 15],
  senderAddressLine1: ['sender_address_line1', 240], senderAddressLine2: ['sender_address_line2', 240],
  senderCity: ['sender_city', 120], senderState: ['sender_state', 120],
  senderPostcode: ['sender_postcode', 20], senderCountry: ['sender_country', 2],
};

export async function migrateSenderSettings(store) {
  const postgres = store.dialect === 'postgres';
  const present = postgres
    ? (await store.all("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'company_setting'")).map(row => row.name)
    : (await store.all("SELECT name FROM pragma_table_info('company_setting')")).map(row => row.name);
  for (const [column, max] of Object.values(senderFields)) {
    const minimum = column === 'sender_country' ? 2 : column === 'sender_phone' ? 8 : 1;
    const content = column === 'sender_phone'
      ? (postgres ? ` AND ${column} ~ '^[0-9]+$'` : ` AND ${column} NOT GLOB '*[^0-9]*'`)
      : column === 'sender_country' ? (postgres ? ` AND ${column} ~ '^[A-Z]{2}$'` : ` AND ${column} GLOB '[A-Z][A-Z]'`) : '';
    if (!present.includes(column)) await store.exec(`ALTER TABLE company_setting ADD COLUMN ${column} TEXT CHECK (${column} IS NULL OR (length(${column}) BETWEEN ${minimum} AND ${max}${content}))`);
  }
}
