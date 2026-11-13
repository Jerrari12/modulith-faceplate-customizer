// Phosphor icons from the committed sprite icons/phosphor.svg (built by tools/make-icons.mjs), the planner's way:
// Regular for idle, Fill for active. icon('cube') returns an <svg> that inherits currentColor.

const SPRITE = new URL('../../icons/phosphor.svg', import.meta.url).href.replace(/\?.*$/, '');

export function icon(name, { fill = false, size = 18, label = null } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ph');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 256 256');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${SPRITE}#ph-${name}${fill ? '-fill' : ''}`);
  svg.appendChild(use);
  return svg;
}

/** The same icon as markup, for innerHTML templates. */
export function iconHtml(name, size = 18, fill = false) {
  return `<svg class="ph" width="${size}" height="${size}" viewBox="0 0 256 256" aria-hidden="true"><use href="${SPRITE}#ph-${name}${fill ? '-fill' : ''}"/></svg>`;
}
