/**
 * Minimal DOM shim for testing bench/ui/charts.js under `node --test`.
 * Elements are plain objects recording namespace, tag, attributes, children,
 * and text content; only the surface charts.js uses (`createElementNS`,
 * `setAttribute`, `getAttribute`, `appendChild`, `textContent`) is modeled.
 *
 * @module bench/tests/helpers/dom-shim
 */

/**
 * @typedef {object} ShimElement
 * @property {string} ns - namespace URI.
 * @property {string} tag - tag name.
 * @property {Record<string, string>} attrs - attributes by name.
 * @property {ShimElement[]} children - child elements.
 * @property {string} textContent - text content.
 */

/**
 * Create a shim element.
 * @param {string} ns - namespace URI.
 * @param {string} tag - tag name.
 * @returns {ShimElement}
 */
export function createElementNS(ns, tag) {
  const el = {
    ns,
    tag,
    attrs: Object.create(null),
    children: [],
    textContent: '',
    /**
     * @param {string} name - attribute name.
     * @param {string} value - attribute value.
     * @returns {void}
     */
    setAttribute(name, value) { el.attrs[name] = String(value) },
    /**
     * @param {string} name - attribute name.
     * @returns {string | null}
     */
    getAttribute(name) { return name in el.attrs ? el.attrs[name] : null },
    /**
     * @param {ShimElement} child - child to append.
     * @returns {ShimElement}
     */
    appendChild(child) { el.children.push(child); return child },
  }
  return el
}

/**
 * Create an HTML-namespaced shim element.
 * @param {string} tag - tag name.
 * @returns {ShimElement}
 */
export function createElement(tag) {
  return createElementNS('http://www.w3.org/1999/xhtml', tag)
}

/**
 * Install the shim as `globalThis.document`.
 * @returns {() => void} - restore function.
 */
export function installDocument() {
  const previous = globalThis.document
  globalThis.document = { createElementNS, createElement }
  return () => {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

/**
 * Depth-first walk of a shim tree, root included.
 * @param {ShimElement} root - tree root.
 * @returns {ShimElement[]}
 */
export function walk(root) {
  return [root, ...root.children.flatMap(walk)]
}

/**
 * All descendants (root excluded) with the given tag.
 * @param {ShimElement} root - tree root.
 * @param {string} tag - tag name.
 * @returns {ShimElement[]}
 */
export function byTag(root, tag) {
  return walk(root).filter(n => n !== root && n.tag === tag)
}

/**
 * All descendants (root included) carrying a class token.
 * @param {ShimElement} root - tree root.
 * @param {string} cls - single class token.
 * @returns {ShimElement[]}
 */
export function byClass(root, cls) {
  return walk(root).filter(n => (n.attrs.class ?? '').split(/\s+/).includes(cls))
}

/**
 * Read an attribute, parsed as a number when possible.
 * @param {ShimElement} node - shim element.
 * @param {string} name - attribute name.
 * @returns {string | undefined}
 */
export function attr(node, name) {
  return node.attrs[name]
}
