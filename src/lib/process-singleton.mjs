/**
 * Process-wide registry for mutable runtime state.
 *
 * Next.js evaluates a source module separately in every module graph that bundles it:
 * server-rendered pages and route handlers each run their own copy, and instrumentation
 * loads another. A module-level variable therefore exists once per copy, so a cache that a
 * route handler clears would stay populated in the copy that pages read. Values registered
 * here live on `globalThis` under `Symbol.for("vicky.<name>")`, which every copy in the
 * process resolves to the same instance, including the unbundled `server.mjs`.
 *
 * Registered values outlive module re-evaluation during `next dev`. After changing the shape
 * of a registered value, restart the dev server or register the new shape under a new name.
 */

/**
 * @param {string} name
 * @returns {symbol}
 */
const registryKey = (name) => Symbol.for(`vicky.${name}`);

/**
 * Returns the value registered under `name`, creating and registering it on first use.
 *
 * @template T
 * @param {string} name
 * @param {() => T} create
 * @returns {T}
 */
export function processSingleton(name, create) {
  const key = registryKey(name);
  if (key in globalThis) {
    return globalThis[key];
  }

  const value = create();
  globalThis[key] = value;
  return value;
}

/**
 * Returns the value registered under `name`, or `undefined` when nothing registered it yet.
 *
 * @param {string} name
 * @returns {unknown}
 */
export function peekProcessSingleton(name) {
  return globalThis[registryKey(name)];
}
