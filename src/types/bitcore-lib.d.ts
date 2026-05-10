/**
 * Minimal ambient types for `bitcore-lib`.
 *
 * The npm package ships no `.d.ts` and `@types/bitcore-lib` exists
 * but lags real-world API additions (e.g. `deriveNonCompliantChild`).
 * Declaring as `any` keeps the build green; keys.ts is the only call
 * site and the surface we use is small enough that the loss of
 * type-safety is contained — runtime errors bubble up as the
 * `bitcore-lib` constructors throw on malformed inputs.
 */
declare module 'bitcore-lib';
