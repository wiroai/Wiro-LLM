declare const __PACKAGE_VERSION__: string | undefined;

/**
 * The version of this package. The build replaces `__PACKAGE_VERSION__` with
 * the version in package.json.
 */
export const VERSION: string =
  typeof __PACKAGE_VERSION__ !== 'undefined' ? __PACKAGE_VERSION__ : '0.0.0-test';
