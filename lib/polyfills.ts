/**
 * Old browsers / WebViews (Safari before 15.4, old Android WebView) lack Object.hasOwn, which some libraries call:
 * the screen crashed with "Object.hasOwn is not a function". Same behaviour, added only where it is missing.
 */
if (typeof (Object as any).hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', { value: (o: any, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k), configurable: true, writable: true });
}
export {};
