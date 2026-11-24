export function showBootLoader() {
  const loader = document.getElementById('seller-boot-loader');
  if (!loader) return;
  loader.hidden = false;
  document.body.classList.add('seller-booting');
}

export function hideBootLoader() {
  const loader = document.getElementById('seller-boot-loader');
  if (loader) loader.hidden = true;
  document.body.classList.remove('seller-booting');
}
