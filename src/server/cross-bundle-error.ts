/**
 * Makes `instanceof` recognise an error class across copies of its module.
 *
 * `getAuthServices()` builds the shared services once and keeps them on
 * `globalThis`, so an error one of them throws is built from the module copy
 * that created the services. Under `next dev` a route compiled later runs a
 * fresh copy of the same module, its class is another object, and a plain
 * `error instanceof X` misses: the Sudo mode gate answered `500` instead of
 * `428` (account-center A9). The optimized server (`next build`) keeps one
 * copy of every module in one webpack runtime, so production does not see
 * this; the brand keeps the checks right in both.
 *
 * The brand is a `Symbol.for` key, shared by every copy in the process, set
 * on the class prototype; the class's `Symbol.hasInstance` reads it, so the
 * existing `instanceof` checks stay as they are. Each class names its own
 * key (class names are minified in a build). A subclass that does not brand
 * itself keeps the ordinary prototype check.
 *
 * Call it from the class's static block: `static { brandCrossBundleError(this, "SudoRequiredError"); }`.
 */
export function brandCrossBundleError(errorClass: abstract new (...args: never[]) => Error, key: string) {
  const brand = Symbol.for(`skylab.account-center.error.${key}`);
  Object.defineProperty(errorClass.prototype, brand, { value: true });
  Object.defineProperty(errorClass, Symbol.hasInstance, {
    value: function hasCrossBundleBrand(this: unknown, value: unknown) {
      if (this !== errorClass) return Function.prototype[Symbol.hasInstance].call(this, value);
      return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[brand] === true;
    },
  });
}
