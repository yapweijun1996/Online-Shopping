export class FieldError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

export function boundedText(value, field, maxLength, required = true) {
  if (value === null || value === undefined) value = '';
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw new FieldError(field, 'Enter valid text.');
  const text = value.trim().normalize('NFC');
  if ((required && !text) || text.length > maxLength) throw new FieldError(field, 'Enter valid text.');
  return text;
}
