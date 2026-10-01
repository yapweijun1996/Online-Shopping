import { productMedia, setProductMedia } from './product-media.js';
import { locale, t } from '../shared/i18n.js';
import { formatCatalogPrice } from './catalog-presentation.js';
const formatMoney = (minor, currency) => formatCatalogPrice(minor, currency, locale());
import { productHash } from './shop-route.js';
import { productShareURL, shareProduct } from './product-share.js';
import { attachImageZoom } from './image-zoom.js';

export function sellerChatURL(phone) {
  return typeof phone === 'string' && /^[1-9]\d{7,14}$/.test(phone)
    ? `https://wa.me/${phone}`
    : null;
}

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

export function mountProductDetail(root, { api, addToCart, checkout, shop, notify, updateBanner, cartQuantity = () => 0 }) {
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
    const gallery = root.querySelector('.product-image-button');
    const navigation = root.querySelector('.product-navigation');
    if (!gallery || !navigation || root.hidden) return;
    navigation.classList.toggle('product-navigation-solid', gallery.getBoundingClientRect().bottom <= navigation.getBoundingClientRect().bottom);
  }
  window.addEventListener('scroll', syncFloatingNavigation, { passive: true });
  window.addEventListener('resize', syncFloatingNavigation);

  let imageZoom;
  function closeImage() {
    imageZoom?.destroy();
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
    navigation.append(back, node('span', 'product-navigation-title', t('productInformation')));
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
    const media = productMedia(product);
    const images = media.map(item => item.src);
    activeImageIndex = Math.min(activeImageIndex, Math.max(0, images.length - 1));
    const zoom = node('dialog', 'image-viewer');
    zoom.setAttribute('aria-label', product.name);
    const zoomImage = images.length ? node('img', 'zoom-image') : image(product, 'zoom-image');
    zoomImage.alt = media[activeImageIndex]?.alt || product.name;
    const zoomClose = button('', () => {}, 'image-close');
    zoomClose.setAttribute('aria-label', t('close'));
    zoomClose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg>';
    const zoomHeader = node('div', 'image-viewer-header');
    const zoomCount = node('span', 'image-viewer-count', `${activeImageIndex + 1} / ${images.length}`);
    zoomHeader.append(zoomCount, zoomClose);
    zoom.append(zoomHeader, zoomImage);

    const imageButton = node('button', 'product-image-button');
    imageButton.type = 'button';
    imageZoom = attachImageZoom(zoom, zoomImage, imageButton, zoomClose);
    imageButton.addEventListener('click', () => { if (media[activeImageIndex]) setProductMedia(zoomImage, media[activeImageIndex], 'full'); imageZoom.open(); });
    imageButton.setAttribute('aria-label', `${t('zoomImage')}: ${product.name}`);
    imageButton.disabled = !images.length;
    const mainImage = images.length ? node('img', 'product-main-image') : image(product, 'product-main-image');
    if (media[activeImageIndex]) setProductMedia(mainImage, media[activeImageIndex]);
    const imageError = node('span', 'product-image-error', t('imageMissing')); imageError.hidden = true;
    mainImage.addEventListener('error', () => { mainImage.hidden = true; imageError.hidden = false; });
    mainImage.addEventListener('load', () => { mainImage.hidden = false; imageError.hidden = true; });
    mainImage.draggable = false;
    zoomImage.draggable = false;
    const zoomCue = node('span', 'product-zoom-cue');
    zoomCue.setAttribute('aria-hidden', 'true');
    zoomCue.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>';
    imageButton.append(mainImage, imageError, zoomCue);
    const imageCount = node('span', 'image-count', `${activeImageIndex + 1} / ${images.length}`);
    imageCount.setAttribute('aria-hidden', 'true');
    if (images.length) imageButton.append(imageCount);
    gallery.append(imageButton);
    const photoCaption = node('p', 'product-photo-caption', media[activeImageIndex]?.caption || '');
    photoCaption.hidden = !photoCaption.textContent; gallery.append(photoCaption);
    const galleryProductId = product.id;
    const rememberPhoto = () => { if (product?.id === galleryProductId && location.hash === productHash(galleryProductId)) history.replaceState({ ...history.state, shopGallery: { id: galleryProductId, index: activeImageIndex } }, '', location.href); };
    zoom.addEventListener('close', rememberPhoto);
    if (images.length > 1) {
      const photoStatus = node('span', 'sr-only');
      photoStatus.setAttribute('role', 'status');
      gallery.append(photoStatus);
      const thumbs = node('div', 'product-thumbnails');
      const viewerThumbs = node('div', 'viewer-thumbnails');
      const updateImage = (index) => {
        activeImageIndex = (index + images.length) % images.length;
        mainImage.hidden = false; imageError.hidden = true;
        setProductMedia(mainImage, media[activeImageIndex]);
        photoCaption.textContent = media[activeImageIndex].caption; photoCaption.hidden = !photoCaption.textContent;
        rememberPhoto();
        imageZoom.reset();
        if (zoom.open) setProductMedia(zoomImage, media[activeImageIndex], 'full');
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
      swipe(imageButton);
      imageZoom.setSwipe(direction => updateImage(activeImageIndex + direction));
      imageButton.addEventListener('click', (event) => {
        if (!ignoreClick) return;
        ignoreClick = false;
        event.stopImmediatePropagation();
      }, true);
      imageButton.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); updateImage(activeImageIndex + (event.key === 'ArrowLeft' ? -1 : 1));
      });
      zoom.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || !zoom.open) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); updateImage(activeImageIndex + (event.key === 'ArrowLeft' ? -1 : 1));
      });
      images.forEach((source, index) => {
        const thumbnail = button('', () => updateImage(index), 'product-thumbnail');
        thumbnail.setAttribute('aria-label', t('photoNumber').replace('{number}', String(index + 1)));
        thumbnail.setAttribute('aria-pressed', String(index === activeImageIndex));
        const preview = node('img');
        setProductMedia(preview, media[index], 'thumbnail');
        thumbnail.append(preview);
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
    const headingBlock = node('div', 'product-heading-block');
    const priceBlock = node('div', 'product-price-block');
    priceBlock.append(node('span', 'product-price-label', t(shop()?.mode === 'demo' ? 'referencePrice' : 'unitPrice')), node('strong', 'product-price', formatMoney(product.priceMinor, product.currency)));
    const keyDetails = node('dl', 'product-key-details');
    for (const [label, value] of [[t('sku'), product.sku], [t('category'), product.category]]) keyDetails.append(node('dt', '', label), node('dd', '', value));
    headingBlock.append(title, priceBlock, keyDetails);
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
    const feedback = node('p', 'detail-feedback', statusKey && statusKey !== 'addedToCart' ? t(statusKey) : '');
    feedback.setAttribute('role', 'status');
    feedback.dataset.state = statusKey === 'addedToCart' ? 'success' : statusKey ? 'error' : '';
    const purchaseBar = node('div', 'product-purchase');
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
        feedback.textContent = added ? '' : t(statusKey);
        feedback.dataset.state = added ? 'success' : 'error';
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
    const sellerPhone = shop()?.sellerWhatsAppPhone;
    const chatURL = sellerChatURL(sellerPhone);
    const chatAvailable = Boolean(chatURL);
    const chat = chatAvailable
      ? link('', chatURL, 'product-chat')
      : button('', () => notify?.('chatUnavailable'), 'product-chat');
    chat.setAttribute('aria-label', t(chatAvailable ? 'openWhatsApp' : 'chatUnavailable'));
    if (chatAvailable) {
      chat.target = '_blank';
      chat.rel = 'noopener noreferrer';
    }
    chat.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/></svg>';
    chat.append(node('span', '', t('chat')));
    const add = button(t('addToCart'), () => purchase(false), 'product-add');
    const buy = button(t('buyNow'), () => purchase(true), 'primary-button product-buy');
    add.disabled = buy.disabled = busy;
    purchaseBar.append(chat, add, buy);
    const shareStatus = node('p', 'shop-note'); shareStatus.setAttribute('role', 'status');
    const shareField = node('input', 'share-url'); shareField.readOnly = true; shareField.hidden = true;
    shareField.setAttribute('aria-label', t('productLink'));
    let sharing = false;
    const share = button(t('shareProduct'), async () => {
      if (sharing) return;
      sharing = true; share.disabled = true; share.setAttribute('aria-busy', 'true');
      shareStatus.textContent = ''; shareField.hidden = true;
      const id = product.id;
      const url = productShareURL(id, location.href);
      const isCurrent = () => share.isConnected && !root.hidden && location.hash === productHash(id);
      const result = await shareProduct({ title: product.name, url }, navigator, isCurrent);
      if (result && isCurrent()) {
        shareStatus.textContent = t(result);
        if (result === 'copyLinkHelp') {
          shareField.value = url; shareField.hidden = false; shareField.focus(); shareField.select();
        }
      }
      sharing = false; share.disabled = false; share.removeAttribute('aria-busy');
    }, 'text-button');
    share.className = 'product-share';
    share.setAttribute('aria-label', t('shareProduct'));
    share.title = t('shareProduct');
    share.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12.5 16 8M8 11.5l8 4.5"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="18" cy="17" r="2"/></svg>';
    const cartNavigation = link('', '#cart', 'product-nav-cart');
    cartNavigation.setAttribute('aria-label', t('viewCart'));
    cartNavigation.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 4h2l2.3 11.5h11.7L21 7H5"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg>';
    cartNavigation.append(node('span', 'product-cart-count'));
    navigation.append(share, cartNavigation);
    updateCartCount();
    headingBlock.append(shareStatus, shareField);
    selectionBlock.append(quantityRow, purchaseBar, feedback);
    const demo = shop()?.mode === 'demo';
    const serviceDetails = node('div', 'product-service-details');
    const serviceRows = demo
      ? [['stockAndDelivery', 'demoAvailability'], ['demoOrderInformation', 'demoBrief']]
      : [['stockAndDelivery', 'availabilityUnconfirmed'], ['shipping', 'shippingUnconfirmed'], ['returnsAndGuarantees', 'returnsUnconfirmed']];
    for (const [heading, copy] of serviceRows) {
      const section = node('details', 'product-service-row');
      section.append(node('summary', '', t(heading)), node('p', '', t(copy)));
      serviceDetails.append(section);
    }
    if (updateBanner) summary.append(updateBanner);
    summary.append(headingBlock, selectionBlock, serviceDetails);
    layout.append(gallery, summary);
    if (demo) {
      const demoNote = node('p', 'product-demo-note', t('demoNotice'));
      summary.insertBefore(demoNote, selectionBlock);
    }
    const description = node('section', 'product-description-section');
    description.append(node('h2', '', t('productInformation')));
    const specs = node('dl', 'detail-specifications');
    for (const [key, value] of [[t('sku'), product.sku], [t('category'), product.category]]) {
      specs.append(node('dt', '', key), node('dd', '', value));
    }
    description.append(specs, node('h3', 'description-heading', t('description')),
      node('p', 'detail-description', product.description));
    const reviews = node('details', 'product-reviews');
    reviews.append(node('summary', '', t('reviews')), node('p', '', t('reviewsUnavailable')));
    root.append(layout, description, reviews, zoom);
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
        const relatedImage = image(item, 'related-image');
        relatedImage.loading = 'lazy'; relatedImage.decoding = 'async';
        card.append(relatedImage, node('h3', '', item.name), node('strong', '', formatMoney(item.priceMinor, item.currency)));
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
      const savedPhoto = history.state?.shopGallery;
      if (savedPhoto?.id === id && Number.isInteger(savedPhoto.index)) activeImageIndex = Math.max(0, Math.min(savedPhoto.index, productMedia(result).length - 1));
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
  function updateCartCount() {
    const control = root.querySelector('.product-nav-cart');
    if (!control) return;
    const count = cartQuantity();
    const badge = control.querySelector('.product-cart-count');
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
    control.setAttribute('aria-label', `${t('cart')}: ${count}`);
  }
  return {
    updateCartCount,
    show,
    hide() { request++; currentId = undefined; product = null; busy = false; closeImage(); },
    refreshLocale() { if (busy) localePending = true; else render(); },
  };
}
