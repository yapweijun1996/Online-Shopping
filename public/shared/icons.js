const paths = {
  up: 'm6 12 6-6 6 6M12 6v14',
  down: 'm6 12 6 6 6-6M12 18V4',
  left: 'm12 6-6 6 6 6M6 12h14',
  right: 'm12 6 6 6-6 6M18 12H4',
  close: 'm6 6 12 12M6 18 18 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  reset: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
  image: 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M7 7h.01',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
  square: 'M4 4h16v16H4z',
  user: 'M8 6a4 4 0 1 0 8 0 4 4 0 0 0-8 0M4 22v-3a8 8 0 0 1 16 0v3',
  more: 'M4 12h.01M12 12h.01M20 12h.01',
};

export function icon(name) {
  if (!Object.hasOwn(paths, name)) throw new RangeError(`Unknown icon: ${name}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ui-icon' })) svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]); svg.append(path);
  return svg;
}
