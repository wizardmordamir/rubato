/**
 * Pure, display-only rendering of a Target into a human-readable selector string.
 *
 * The REAL locator resolution happens in Node (src/scripts/browser-host.mjs,
 * resolveLocator) because Playwright can't run under Bun. This function must stay
 * in lockstep with that one — it's used for the UI's selector preview and for
 * step-result labels, so it should read the way the resolved locator behaves.
 */

import type { Target } from '../shared/automation';

export function targetToSelectorString(target: Target): string {
  const self = ownSelector(target);
  return target.container ? `${targetToSelectorString(target.container)} » ${self}` : self;
}

function ownSelector(target: Target): string {
  const nth = typeof target.nth === 'number' ? `[${target.nth}]` : '';
  switch (target.kind) {
    case 'role':
      return `role=${target.value}${target.name ? `[name=${JSON.stringify(target.name)}${target.exact ? ' exact' : ''}]` : ''}${nth}`;
    case 'testid':
      return `testid=${target.value}${nth}`;
    case 'text':
      return `text=${JSON.stringify(target.value)}${target.exact ? ' (exact)' : ''}${nth}`;
    case 'label':
      return `label=${JSON.stringify(target.value)}${nth}`;
    case 'placeholder':
      return `placeholder=${JSON.stringify(target.value)}${nth}`;
    case 'id':
      return `#${target.value}${nth}`;
    case 'class':
      return `.${target.value}${nth}`;
    case 'href':
      return `a[href=${JSON.stringify(target.value)}]${nth}`;
    case 'css':
      return `${target.value}${nth}`;
    default:
      return target.value;
  }
}
