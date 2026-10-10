// All app pages are one level below their tenant base; the default base is empty.
export function basePath(pathname = globalThis.location?.pathname || '') {
  const match = /^(?:\/([a-z0-9]{3,30}))?\/(shop|seller)(\/|$)/.exec(pathname);
  return match?.[1] ? `/${match[1]}` : '';
}
export function apiUrl(path, pathname) {
  return `${basePath(pathname)}/api/${path.replace(/^\/+/, '')}`;
}
