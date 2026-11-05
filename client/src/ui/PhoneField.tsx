import { useMemo, useRef, useState } from 'preact/hooks';
import type { CountryCode } from 'libphonenumber-js/min';
import { countries, formatAsYouType } from '../lib/phone';
import { getNav } from './nav';
import { ChevronDown, Search } from './icons';

export interface PhoneValue {
  country: CountryCode;
  national: string;
}

export function PhoneField({ value, onChange, autoFocus, onSubmit }: {
  value: PhoneValue;
  onChange: (v: PhoneValue) => void;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  const country = countries().find((c) => c.code === value.country) ?? countries()[0];
  const inputRef = useRef<HTMLInputElement>(null);

  const pickCountry = () => {
    getNav().present((close) => (
      <CountryPicker
        selected={value.country}
        onPick={async (code) => {
          await close();
          onChange({ ...value, country: code });
          inputRef.current?.focus();
        }}
      />
    ), { variant: 'full' });
  };

  return (
    <div class="phone-field">
      <button type="button" class="phone-country" onClick={pickCountry} aria-label={`Country: ${country.name}`}>
        <span class="flag">{country.flag}</span>
        <span>+{country.dial}</span>
        <ChevronDown size={16} />
      </button>
      <input
        ref={inputRef}
        class="phone-input"
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder="Phone number"
        aria-label="Phone number"
        autoFocus={autoFocus}
        value={value.national}
        maxLength={24}
        onInput={(e) => {
          const raw = (e.target as HTMLInputElement).value;
          // Keep the cursor sane: only reformat when typing at the end.
          const formatted = raw.startsWith('+') ? raw : formatAsYouType(raw.replace(/[^\d]/g, ''), value.country);
          onChange({ ...value, national: formatted });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit?.();
        }}
      />
    </div>
  );
}

function CountryPicker({ selected, onPick }: { selected: CountryCode; onPick: (c: CountryCode) => void }) {
  const [query, setQuery] = useState('');
  const list = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\+/, '');
    if (!q) return countries();
    return countries().filter((c) => c.name.toLowerCase().includes(q) || c.dial.startsWith(q) || c.code.toLowerCase() === q);
  }, [query]);

  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <span />
        <strong>Country</strong>
        <span />
      </div>
      <div class="search-bar">
        <Search size={18} />
        <input type="search" placeholder="Search" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search countries" />
      </div>
      <div class="sheet-scroll">
        <div class="plain-list">
          {list.map((c) => (
            <button key={c.code} class={`plain-row${c.code === selected ? ' selected' : ''}`} onClick={() => onPick(c.code)}>
              <span class="flag">{c.flag}</span>
              <span class="plain-row-title">{c.name}</span>
              <span class="plain-row-value">+{c.dial}</span>
            </button>
          ))}
          {!list.length && <p class="muted center pad">No matches</p>}
        </div>
      </div>
    </div>
  );
}
