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
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  chevronDown: 'm6 9 6 6 6-6',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M4 21h16',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  lock: 'M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3M12 15v2',
  key: 'M4 15a4 4 0 1 0 8 0 4 4 0 0 0-8 0M11 12l9-9M16 7l3 3',
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  eyeOff: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0M3 3l18 18',
};

export function icon(name) {
  if (!Object.hasOwn(paths, name)) throw new RangeError(`Unknown icon: ${name}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ui-icon' })) svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]); svg.append(path);
  return svg;
}
