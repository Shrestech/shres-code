# CONVENTIONS

House conventions for the toolbox package. Every module under `src/` follows
this guide; reviewers reject patches that deviate from it.

## Modules

- Plain ESM JavaScript, one exported function per module, no dependencies.
- Declare exports inline with the declaration; never use `export { … }` lists.
- Every exported function carries JSDoc with `@param` and `@returns`.

## Validation messages

Every exported function validates its arguments before doing any work. An
invalid argument throws a `TypeError` whose message follows exactly this
format:

```
<argName> is not valid for <fnName>
```

The argument name first, then `is not valid for`, then the function name — no
other punctuation. For example, calling `formatAmount('5', 'USD')` throws
`TypeError: amount is not valid for formatAmount`, and `src/currency.js`
(shipped) is the reference implementation of this convention.
