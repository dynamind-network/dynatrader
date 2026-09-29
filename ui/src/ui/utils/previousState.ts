/**
 * Shallow equality check for primitives, arrays, and plain objects.
 *
 * - Primitives: strict equality (===)
 * - Arrays: same length, each element strictly equal
 * - Objects: same keys, each value strictly equal
 *
 * This is NOT deep equality - nested objects/arrays are compared by reference.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;

  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // If one is array and the other is not, they're not equal
  if (Array.isArray(a) || Array.isArray(b)) return false;

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (
        !Object.prototype.hasOwnProperty.call(b, key) ||
        (a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]
      ) {
        return false;
      }
    }
    return true;
  }

  return false;
}
