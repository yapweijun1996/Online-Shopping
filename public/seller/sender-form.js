import { senderInputLimits, senderCountryOptions } from '../shared/sender-fields.js';
import { t } from '../shared/i18n.js';

export function mountSenderFields(root) {
  const make = (tag, key) => { const node = document.createElement(tag); if (key) { node.dataset.i18n = key; node.textContent = t(key); } return node; };
  const inputs = {};
  const auto = { senderName: 'name', senderPhone: 'tel', senderAddressLine1: 'address-line1', senderAddressLine2: 'address-line2', senderCity: 'address-level2', senderState: 'address-level1', senderPostcode: 'postal-code', senderCountry: 'country' };
  root.classList.add('sender-settings'); root.append(make('h2', 'senderDetails'), make('p', 'senderOptional'));
  const contact = make('fieldset'), address = make('fieldset'); contact.append(make('legend', 'senderContact')); address.append(make('legend', 'senderAddress')); root.append(contact, address);
  const country = make('select'); country.name = 'senderCountry'; country.id = 'sender-field-senderCountry'; country.autocomplete = 'section-sender country'; inputs.senderCountry = country;
  const otherLabel = make('label'); otherLabel.className = 'sender-country-other'; otherLabel.hidden = true;
  const other = make('input'); other.name = 'senderCountryOther'; other.maxLength = senderInputLimits.senderCountry; other.id = 'sender-country-other'; other.autocomplete = 'off'; otherLabel.append(make('span', 'senderCountryOther'), other);
  const fields = ['senderName', 'senderPhone', 'senderCountry', 'senderAddressLine1', 'senderAddressLine2', 'senderCity', 'senderState', 'senderPostcode'];
  for (const name of fields) {
    const label = make('label'), input = name === 'senderCountry' ? country : make('input'); label.dataset.senderField = name; label.append(make('span', name === 'senderAddressLine2' ? 'senderAddressLine2Optional' : name));
    if (name !== 'senderCountry') { input.name = name; input.id = `sender-field-${name}`; input.maxLength = senderInputLimits[name]; input.type = name === 'senderPhone' ? 'tel' : 'text'; input.autocomplete = `section-sender ${auto[name]}`; inputs[name] = input; }
    if (name === 'senderPhone') { input.inputMode = 'tel'; input.placeholder = '+60 / +65'; }
    label.append(input); (['senderName', 'senderPhone'].includes(name) ? contact : address).append(label);
    if (name === 'senderCountry') {
      const help = make('p', 'senderCountryHelp'); help.id = 'sender-country-help'; help.className = 'sender-field-help'; country.setAttribute('aria-describedby', help.id); other.setAttribute('aria-describedby', help.id); address.append(otherLabel, help);
    }
    if (name === 'senderPhone') { const help = make('p', 'senderPhoneHelp'); help.id = 'sender-phone-help'; help.className = 'sender-field-help'; input.setAttribute('aria-describedby', help.id); contact.append(help); }
  }
  function refreshLocale() {
    const selected = country.value;
    country.replaceChildren();
    const add = (code, label) => { const option = make('option'); option.value = code; option.textContent = label; country.append(option); };
    add('', t('senderCountryBlank'));
    for (const { code, name } of senderCountryOptions(document.documentElement.lang || 'en')) add(code, `${name} (${code})`);
    if (selected && selected !== '__other__' && ![...country.options].some(option => option.value === selected)) add(selected, selected);
    add('__other__', t('senderCountryOther')); country.value = selected; otherLabel.hidden = selected !== '__other__'; other.disabled = otherLabel.hidden;
  }
  country.addEventListener('change', () => { otherLabel.hidden = country.value !== '__other__'; other.disabled = otherLabel.hidden; if (!otherLabel.hidden) other.focus(); });
  refreshLocale();
  return {
    inputs,
    countryValue: () => country.value === '__other__' ? other.value : country.value,
    setCountry(value) { const code = value || ''; if (code && ![...country.options].some(option => option.value === code)) { const option = make('option'); option.value = code; option.textContent = code; country.append(option); } country.value = code; other.value = ''; otherLabel.hidden = true; other.disabled = true; },
    field: name => name === 'senderCountry' && country.value === '__other__' ? other : inputs[name],
    refreshLocale,
  };
}
