import { AsYouType, getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

export interface Country {
  code: CountryCode;
  name: string;
  dial: string;
  flag: string;
}

const flag = (code: string) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

let cache: Country[] | null = null;

export function countries(): Country[] {
  if (cache) return cache;
  const names = new Intl.DisplayNames([navigator.language, 'en'], { type: 'region' });
  cache = getCountries()
    .map((code) => ({ code, name: names.of(code) ?? code, dial: getCountryCallingCode(code), flag: flag(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

/** Best guess for the user's country from the browser language, e.g. de-AT -> AT. */
export function guessCountry(): CountryCode {
  for (const lang of navigator.languages ?? [navigator.language]) {
    const region = lang.split('-')[1]?.toUpperCase();
    if (region && (getCountries() as string[]).includes(region)) return region as CountryCode;
  }
  return 'DE';
}

export function formatAsYouType(national: string, country: CountryCode) {
  return new AsYouType(country).input(national);
}

/** Returns E.164 or null. Accepts a full international number in the field too. */
export function toE164(input: string, country: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(input, country);
  return parsed && parsed.isValid() ? parsed.number : null;
}

export function prettyPhone(e164: string) {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

/** How to show who someone is: @username, else the phone number of an older account. */
export function handleOf(p: { phone?: string | null; username?: string | null } | null | undefined) {
  if (!p) return '';
  if (p.username) return `@${p.username}`;
  return p.phone ? prettyPhone(p.phone) : '';
}
