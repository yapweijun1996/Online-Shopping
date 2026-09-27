import { formatMoney, t } from '../shared/i18n.js';
import { productHash } from './shop-route.js';

function node(tag, className = '', text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function link(text, href, className = '') {
  const element = node('a', className, text);
  element.href = href;
  return element;
}
function button(text, handler, className = 'outline-button') {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', handler);
  return element;
}
function image(product, className, source = product.imageUrl) {
  if (!source) return node('div', `${className} image-placeholder`, t('imageMissing'));
  const element = node('img', className);
  element.src = source;
  element.alt = product.name;
  return element;
}

export function mountProductDetail(root, { api, addToCart, checkout, shop }) {
  let request = 0;
  let product = null;
  let related = [];
  let currentId;
  let quantityValue = '1';
  let busy = false;
  let statusKey = '';
  let errorKey = '';
  let localePending = false;
  let activeImageIndex = 0;

  function syncFloatingNavigation() {
    const gallery = root.querySelector('.product-gallery');
    const navigation = root.querySelector('.product-navigation');
    if (!gallery || !navigation || root.hidden) return;
    navigation.classList.toggle('product-navigation-solid', gallery.getBoundingClientRect().bottom <= navigation.getBoundingClientRect().bottom);
  }
  window.addEventListener('scroll', syncFloatingNavigation, { passive: true });
  window.addEventListener('resize', syncFloatingNavigation);

  function closeImage() {
    root.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  }

  function render(focus = false) {
    closeImage();
    root.replaceChildren();
    const back = link('', '#catalog', 'product-back');
    back.setAttribute('aria-label', t('continueShopping'));
    const backIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    backIcon.setAttribute('viewBox', '0 0 24 24');
    backIcon.setAttribute('aria-hidden', 'true');
    const backPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    backPath.setAttribute('d', 'm14 5-7 7 7 7M7 12h14');
    backIcon.append(backPath);
    back.append(backIcon, node('span', '', t('continueShopping')));
    const navigation = node('nav', 'product-navigation');
    navigation.setAttribute('aria-label', t('productNavigation'));
    navigation.append(back);
    root.append(navigation);
    if (!product) {
      document.title = `${t(errorKey || 'viewDetails')} · ${shop()?.shopName || t('shop')}`;
      const heading = node('h1', errorKey ? 'product-state' : 'product-state sr-only', t(errorKey || 'loading'));
      heading.id = 'detail-title'; heading.tabIndex = -1;
      root.append(heading);
      if (!errorKey) {
        const placeholder = node('div', 'product-layout product-skeleton loading-placeholder');
        placeholder.setAttribute('aria-hidden', 'true');
        const image = node('div', 'skeleton-image');
        const content = node('div', 'product-skeleton-content');
        for (const width of ['short', '', 'medium', '', 'short']) content.append(node('span', `skeleton-line ${width}`));
        content.append(node('span', 'skeleton-button'));
        placeholder.append(image, content);
        root.append(placeholder);
      }
      if (errorKey === 'networkError') root.append(button(t('retry'), () => show(currentId, true)));
      if (focus) heading.focus({ preventScroll: true });
      return;
    }
    document.title = `${product.name} · ${shop()?.shopName || t('shop')}`;
    const layout = node('div', 'product-layout');
    const gallery = node('div', 'product-gallery');
    const images = product.images?.length ? product.images : (product.imageUrl ? [product.imageUrl] : []);
    activeImageIndex = Math.min(activeImageIndex, Math.max(0, images.length - 1));
    const zoom = node('dialog', 'image-viewer');
    zoom.setAttribute('aria-label', product.name);
    const zoomImage = image(product, 'zoom-image', images[activeImageIndex]);
    const zoomClose = button('', () => zoom.close(), 'image-close');
    zoomClose.setAttribute('aria-label', t('close'));
    zoomClose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg>';
    const zoomHeader = node('div', 'image-viewer-header');
    const zoomCount = node('span', 'image-viewer-count', `${activeImageIndex + 1} / ${images.length}`);
    zoomHeader.append(zoomCount, zoomClose);
    zoom.append(zoomHeader, zoomImage);
    zoom.addEventListener('click', (event) => { if (event.target === zoom) zoom.close(); });
    const imageButton = node('button', 'product-image-button');
    imageButton.type = 'button';
    imageButton.addEventListener('click', () => zoom.showModal());
    imageButton.setAttribute('aria-label', `${t('zoomImage')}: ${product.name}`);
    imageButton.disabled = !images.length;
    const mainImage = image(product, 'product-main-image', images[activeImageIndex]);
    mainImage.draggable = false;
    zoomImage.draggable = false;
    imageButton.append(mainImage);
    const imageCount = node('span', 'image-count', `${activeImageIndex + 1} / ${images.length}`);
    imageCount.setAttribute('aria-hidden', 'true');
    if (images.length > 1) imageButton.append(imageCount);
    gallery.append(imageButton);
    if (images.length > 1) {
      const photoStatus = node('span', 'sr-only');
      photoStatus.setAttribute('role', 'status');
      gallery.append(photoStatus);
      const thumbs = node('div', 'product-thumbnails');
      const viewerThumbs = node('div', 'viewer-thumbnails');
      const updateImage = (index) => {
        activeImageIndex = (index + images.length) % images.length;
        mainImage.src = images[activeImageIndex];
        zoomImage.src = images[activeImageIndex];
        imageCount.textContent = `${activeImageIndex + 1} / ${images.length}`;
        zoomCount.textContent = imageCount.textContent;
        photoStatus.textContent = `${t('photoNumber').replace('{number}', String(activeImageIndex + 1))} / ${images.length}`;
        for (const rail of [thumbs, viewerThumbs]) {
          rail.querySelectorAll('button').forEach((item, position) => item.setAttribute('aria-pressed', String(position === activeImageIndex)));
          const current = rail.children[activeImageIndex];
          if (current) rail.scrollLeft = current.offsetLeft - rail.offsetLeft - (rail.clientWidth - current.clientWidth) / 2;
        }
      };
      const arrow = (direction, inViewer = false) => {
        const control = button('', () => updateImage(activeImageIndex + direction), inViewer ? 'viewer-arrow' : 'gallery-arrow');
        control.setAttribute('aria-label', t(direction < 0 ? 'previousPhoto' : 'nextPhoto'));
        control.dataset.direction = direction < 0 ? 'previous' : 'next';
        control.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction < 0 ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'}"/></svg>`;
        return control;
      };
      gallery.append(arrow(-1), arrow(1));
      zoom.append(arrow(-1, true), arrow(1, true));
      let pointerStart = null;
      let ignoreClick = false;
      const swipe = (surface) => {
        surface.addEventListener('pointerdown', (event) => {
          if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
          pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
          surface.setPointerCapture(event.pointerId);
        });
        surface.addEventListener('pointerup', (event) => {
          if (!pointerStart || event.pointerId !== pointerStart.id) return;
          const dx = event.clientX - pointerStart.x;
          const dy = event.clientY - pointerStart.y;
          pointerStart = null;
          if (Math.hypot(dx, dy) > 12) {
            ignoreClick = true;
            setTimeout(() => { ignoreClick = false; }, 450);
          }
          if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
          updateImage(activeImageIndex + (dx < 0 ? 1 : -1));
        });
        surface.addEventListener('pointercancel', () => { pointerStart = null; });
      };
      swipe(imageButton); swipe(zoomImage);
      imageButton.addEventListener('click', (event) => {
        if (!ignoreClick) return;
        ignoreClick = false;
        event.stopImmediatePropagation();
      }, true);
      zoom.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); updateImage(activeImageIndex + (event.key === 'ArrowLeft' ? -1 : 1));
      });
      images.forEach((source, index) => {
        const thumbnail = button('', () => updateImage(index), 'product-thumbnail');
        thumbnail.setAttribute('aria-label', t('photoNumber').replace('{number}', String(index + 1)));
        thumbnail.setAttribute('aria-pressed', String(index === activeImageIndex));
        thumbnail.append(image(product, '', source));
        thumbs.append(thumbnail);
        const viewerThumbnail = thumbnail.cloneNode(true);
        viewerThumbnail.addEventListener('click', () => updateImage(index));
        viewerThumbs.append(viewerThumbnail);
      });
      gallery.append(thumbs);
      zoom.append(viewerThumbs);
    }
    const summary = node('div', 'product-summary');
    const title = node('h1', '', product.name);
    title.id = 'detail-title'; title.tabIndex = -1;
    const headingMeta = node('div', 'product-heading-meta');
    headingMeta.append(node('p', 'catalog-category', product.category));
    const headingBlock = node('div', 'product-heading-block');
    headingBlock.append(node('strong', 'product-price', formatMoney(product.priceMinor, product.currency)),
      title, headingMeta);
    const selectionBlock = node('div', 'product-selection-block');
    if (product.variants?.length > 1) {
      const variants = node('div', 'product-variants');
      variants.append(node('h2', '', t('chooseVariant')));
      const options = node('div', 'product-variant-options');
      const chooser = node('dialog', 'variant-dialog');
      chooser.setAttribute('aria-label', t('chooseVariant'));
      const chooserHeader = node('header', 'variant-dialog-header');
      const chooserTitle = node('h2', '', t('chooseVariant'));
      const chooserClose = button('', () => chooser.close(), 'variant-dialog-close');
      chooserClose.setAttribute('aria-label', t('close'));
      chooserClose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg>';
      chooserHeader.append(chooserTitle, chooserClose);
      const chooserSummary = node('div', 'variant-dialog-summary');
      if (product.imageUrl) {
        const currentImage = image(product, 'variant-summary-image');
        currentImage.alt = '';
        chooserSummary.append(currentImage);
      }
      const summaryCopy = node('div', 'variant-summary-copy');
      summaryCopy.append(node('strong', '', formatMoney(product.priceMinor, product.currency)),
        node('span', '', product.name));
      chooserSummary.append(summaryCopy);
      const chooserOptions = node('div', 'variant-dialog-options');
      for (const variant of product.variants) {
        const option = link('', productHash(variant.id), 'product-variant');
        if (variant.id === product.id) option.setAttribute('aria-current', 'true');
        option.append(node('span', '', variant.label), node('strong', '', formatMoney(variant.priceMinor, variant.currency)));
        options.append(option);
        const sheetOption = option.cloneNode(true);
        sheetOption.replaceChildren();
        if (variant.imageUrl) {
          const variantImage = image(product, 'variant-option-image', variant.imageUrl);
          variantImage.alt = '';
          sheetOption.append(variantImage);
        }
        sheetOption.append(node('span', 'variant-option-label', variant.label),
          node('strong', '', formatMoney(variant.priceMinor, variant.currency)));
        sheetOption.addEventListener('click', (event) => {
          chooser.close();
          if (variant.id === product.id) event.preventDefault();
        });
        chooserOptions.append(sheetOption);
      }
      variants.append(options);
      const currentVariant = product.variants.find((variant) => variant.id === product.id);
      const choose = button('', () => {
        chooser.showModal();
        chooserOptions.querySelector('[aria-current="true"]')?.focus();
      }, 'variant-chooser-trigger');
      choose.append(node('span', '', t('chooseVariant')), node('strong', '', currentVariant?.label || product.variantLabel));
      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('viewBox', '0 0 24 24');
      chevron.setAttribute('aria-hidden', 'true');
      const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      chevronPath.setAttribute('d', 'm9 5 7 7-7 7');
      chevron.append(chevronPath);
      choose.append(chevron);
      choose.setAttribute('aria-haspopup', 'dialog');
      variants.append(choose);
      chooser.append(chooserHeader, chooserSummary, chooserOptions);
      chooser.addEventListener('close', () => { if (choose.isConnected) choose.focus({ preventScroll: true }); });
      chooser.addEventListener('click', (event) => {
        if (event.target !== chooser) return;
        const rect = chooser.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) chooser.close();
      });
      selectionBlock.append(variants);
      selectionBlock.append(chooser);
    }
    const quantity = node('input');
    quantity.type = 'number'; quantity.min = '1'; quantity.max = '100'; quantity.step = '1';
    quantity.inputMode = 'numeric'; quantity.value = quantityValue; quantity.id = 'detail-quantity';
    const label = node('label', '', t('quantity')); label.htmlFor = quantity.id;
    const quantityRow = node('div', 'product-quantity-row');
    const stepper = node('div', 'quantity-stepper');
    const minus = button('−', () => step(-1)); minus.setAttribute('aria-label', t('decreaseQuantity'));
    const plus = button('+', () => step(1)); plus.setAttribute('aria-label', t('increaseQuantity'));
    stepper.append(minus, quantity, plus);
    const subtotal = node('p', 'product-subtotal');
    quantityRow.append(label, stepper, subtotal);
    const feedback = node('p', 'detail-feedback', statusKey ? t(statusKey) : '');
    feedback.setAttribute('role', 'status');
    feedback.dataset.state = statusKey === 'addedToCart' ? 'success' : statusKey ? 'error' : '';
    const purchaseBar = node('div', 'product-purchase');
    const cartLink = link(t('viewCart'), '#cart', 'outline-button');
    cartLink.hidden = statusKey !== 'addedToCart';
    function syncQuantity() {
      quantityValue = quantity.value;
      const count = quantity.valueAsNumber;
      const valid = Number.isInteger(count) && count >= 1 && count <= 100;
      if (valid && statusKey === 'quantityLimit') {
        statusKey = '';
        feedback.textContent = '';
        feedback.dataset.state = '';
      }
      subtotal.textContent = `${t('itemSubtotal')}: ${valid ? formatMoney(product.priceMinor * count, product.currency) : '—'}`;
      minus.disabled = busy || (valid && count <= 1);
      plus.disabled = busy || (valid && count >= 100);
      quantity.disabled = busy;
    }
    function step(delta) {
      const value = quantity.valueAsNumber;
      quantity.value = String(Math.min(100, Math.max(1, (Number.isInteger(value) ? value : 1) + delta)));
      syncQuantity();
    }
    quantity.addEventListener('input', syncQuantity);
    syncQuantity();
    async function purchase(buyNow) {
      if (busy) return;
      const count = quantity.valueAsNumber;
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        statusKey = 'quantityLimit'; feedback.textContent = t(statusKey); feedback.dataset.state = 'error'; quantity.focus(); return;
      }
      const capturedRequest = request;
      const selectedProduct = product;
      busy = true;
      for (const control of purchaseBar.querySelectorAll('button')) control.disabled = true;
      syncQuantity();
      try {
        if (buyNow) {
          await checkout(() => capturedRequest === request, { productId: selectedProduct.id, quantity: count });
          return;
        }
        const added = await addToCart(selectedProduct, count);
        if (capturedRequest !== request) return;
        statusKey = added ? 'addedToCart' : 'quantityLimit';
        feedback.textContent = t(statusKey);
        feedback.dataset.state = added ? 'success' : 'error';
        cartLink.hidden = !added;
      } catch {
        if (capturedRequest === request) { statusKey = 'networkError'; feedback.textContent = t(statusKey); feedback.dataset.state = 'error'; }
      } finally {
        if (capturedRequest === request) {
          busy = false;
          for (const control of purchaseBar.querySelectorAll('button')) control.disabled = false;
          syncQuantity();
          if (localePending) { localePending = false; render(); }
        }
      }
    }
    const add = button(t('addToCart'), () => purchase(false), 'product-add');
    const buy = button(t('buyNow'), () => purchase(true), 'primary-button product-buy');
    add.disabled = buy.disabled = busy;
    purchaseBar.append(add, buy);
    const shareStatus = node('p', 'shop-note'); shareStatus.setAttribute('role', 'status');
    const shareField = node('input', 'share-url'); shareField.readOnly = true; shareField.hidden = true;
    shareField.setAttribute('aria-label', t('productLink'));
    const share = button(t('copyProductLink'), async () => {
      const url = new URL(productHash(product.id), location.href).href;
      try { await navigator.clipboard.writeText(url); shareStatus.textContent = t('linkCopied'); }
      catch { shareField.value = url; shareField.hidden = false; shareField.focus(); shareField.select(); shareStatus.textContent = t('copyLinkHelp'); }
    }, 'text-button');
    share.className = 'product-share';
    share.setAttribute('aria-label', t('copyProductLink'));
    share.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12.5 16 8M8 11.5l8 4.5"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="18" cy="17" r="2"/></svg>';
    const cartNavigation = link('', '#cart', 'product-nav-cart');
    cartNavigation.setAttribute('aria-label', t('viewCart'));
    cartNavigation.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 4h2l2.3 11.5h11.7L21 7H5"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg>';
    navigation.append(share, cartNavigation);
    headingBlock.append(shareStatus, shareField);
    selectionBlock.append(quantityRow, purchaseBar, feedback, cartLink);
    summary.append(headingBlock, selectionBlock);
    layout.append(gallery, summary);
    if (shop()?.mode === 'demo') {
      const demoNote = node('p', 'product-demo-note', t('demoNotice'));
      summary.prepend(demoNote);
    }
    const description = node('section', 'product-description-section');
    description.append(node('h2', '', t('productInformation')));
    const specs = node('dl', 'detail-specifications');
    for (const [key, value] of [[t('sku'), product.sku], [t('category'), product.category]]) {
      specs.append(node('dt', '', key), node('dd', '', value));
    }
    description.append(specs, node('h3', 'description-heading', t('description')),
      node('p', 'detail-description', product.description));
    root.append(layout, description, zoom);
    root.append(node('section', 'related-products'));
    renderRelated();
    requestAnimationFrame(syncFloatingNavigation);
    if (focus) title.focus({ preventScroll: true });
  }

  function renderRelated() {
    const target = root.querySelector('.related-products');
    if (!target) return;
    target.replaceChildren();
    target.hidden = related.length === 0;
    if (related.length) {
      const section = target;
      section.append(node('h2', '', t('sameCategory')));
      const list = node('div', 'related-grid');
      for (const item of related) {
        const card = link('', productHash(item.id), 'related-card');
        card.append(image(item, 'related-image'), node('h3', '', item.name), node('strong', '', formatMoney(item.priceMinor, item.currency)));
        list.append(card);
      }
      section.append(list);
    }
  }

  async function show(id, force = false) {
    if (!force && currentId === id && product) return;
    const previousGroup = product?.variantGroup;
    const previousQuantity = quantityValue;
    currentId = id;
    const version = ++request;
    product = null; related = []; quantityValue = '1'; activeImageIndex = 0; busy = false; statusKey = ''; errorKey = id ? '' : 'productUnavailable';
    render(true);
    if (!id) return;
    try {
      const result = await api(`/api/v1/products/${id}`);
      if (version !== request) return;
      product = result;
      if (previousGroup && result.variantGroup === previousGroup) quantityValue = previousQuantity;
      render(true);
      const params = new URLSearchParams({ category: result.category, limit: '5' });
      // Recommendations are optional and must never block purchase or reset quantity/focus.
      try {
        const response = await api(`/api/v1/products?${params}`);
        if (version !== request) return;
        related = response.items.filter((item) => item.id !== id).slice(0, 4);
        renderRelated();
      } catch { /* Product details remain usable without recommendations. */ }
    } catch (error) {
      if (version !== request) return;
      errorKey = error.status === 404 ? 'productUnavailable' : 'networkError'; render(true);
    }
  }
  return {
    show,
    hide() { request++; currentId = undefined; product = null; busy = false; closeImage(); },
    refreshLocale() { if (busy) localePending = true; else render(); },
  };
}
