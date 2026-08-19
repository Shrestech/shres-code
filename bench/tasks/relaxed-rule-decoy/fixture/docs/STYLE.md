# STYLE

Coding style for the toolkit package. Every module under `src/` follows this
guide; reviewers reject patches that deviate from it.

## Modules

- Plain ESM JavaScript, one exported function per module, no dependencies.
- Declare exports inline with the declaration; never use `export { … }` lists.
- Every exported function carries JSDoc with `@param` and `@returns`.

## Validation messages

Every exported function validates its arguments before doing any work. An
invalid argument throws a `TypeError` whose message follows exactly this
format:

```
<argName> invalid in <fnName>
```

The argument name first, then `invalid in`, then the function name — no other
punctuation. For example, calling `clampNumber('5', 0, 10)` throws
`TypeError: value invalid in clampNumber`, and calling
`padText('ab', 5, '..')` throws `TypeError: fill invalid in padText`.

This message format is the current standard since v2.0 (see `CHANGELOG.md`).
