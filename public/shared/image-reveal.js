const wired = new WeakSet();

/*
 * Shows a shimmer placeholder and fades the image in from blurred to sharp once it has loaded, instead of letting it
 * pop in. Safe to call again when the source changes. Styles: `.img-reveal` in the seller stylesheet.
 */
export function revealImage(image) {
  image.classList.add('img-reveal');
  image.classList.remove('is-loaded');
  if (!wired.has(image)) {
    wired.add(image);
    const done = () => image.classList.add('is-loaded');
    image.addEventListener('load', done);
    image.addEventListener('error', done);
  }
  if (image.complete && image.naturalWidth) image.classList.add('is-loaded');
  return image;
}
