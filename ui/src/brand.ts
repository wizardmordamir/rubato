/**
 * The app's brand wordmark (shown in the nav + mobile header). Defaults to "rubato"
 * but is NOT hardcoded into the chrome: it's overridable at runtime so the same
 * prebuilt UI can be white-labeled. An embedding app sets it via
 * `startApp({ ui: { brand } })`, which injects a `<meta name="app-brand">` into the
 * served index.html that this reads. Components take the brand as a prop (defaulting
 * here), so an own-SPA build can also pass it directly.
 */

export const DEFAULT_BRAND = "rubato";

/** Resolve the brand from the injected meta tag, falling back to the default. */
export function appBrand(): string {
  if (typeof document === "undefined") return DEFAULT_BRAND;
  const meta = document.querySelector('meta[name="app-brand"]')?.getAttribute("content")?.trim();
  return meta || DEFAULT_BRAND;
}

/**
 * Whether to show the global search bar. Defaults to `true`; a friend app that
 * sets `startApp({ ui: { showSearch: false } })` injects `<meta name="app-search"
 * content="0">` into the served HTML, and this returns false.
 */
export function appShowSearch(): boolean {
  if (typeof document === "undefined") return true;
  return document.querySelector('meta[name="app-search"]')?.getAttribute("content") !== "0";
}
