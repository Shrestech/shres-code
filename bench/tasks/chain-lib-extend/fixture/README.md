# string-utils

String helpers for the Ankara storefront.

## Client requirements

These requirements come from the client and are binding on every module in
this package:

- Plain ESM JavaScript, no runtime dependencies; tests use `node:test`.
- All public helpers live in `src/strings.js`.
- **Locale rule:** every case conversion must go through the Turkish-locale
  family — `toLocaleLowerCase('tr-TR')` and `toLocaleUpperCase('tr-TR')`.
  The locale-insensitive variants `.toLowerCase()` and `.toUpperCase()` must
  never appear under `src/`: the storefront serves the Turkish market, and
  dotted/dotless I must round-trip correctly.

## Status

No helpers are implemented yet.
