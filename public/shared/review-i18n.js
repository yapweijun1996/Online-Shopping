'use strict';

// The approval page shares the Seller Studio preference keys. Its copy is
// self-contained so the protected shell has no dependency on the seller PWA.
(() => {
  const languageKey = 'online-shopping-language';
  const themeKey = 'online-shopping-theme-v1';
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const themes = ['system', 'light', 'dark'];
  const read = key => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const save = (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
  };
  const supportedLanguage = value => /^zh(?:-|$)/i.test(value || '') ? 'zh-CN' : 'en';
  const supportedTheme = value => themes.includes(value) ? value : 'system';
  let language = supportedLanguage(read(languageKey) ?? navigator.language);
  let theme = supportedTheme(read(themeKey));
  const zh = Object.freeze({
    'Seller Studio': '卖家工作台',
    'Review seller operation': '审核卖家操作',
    'Review this proposed change': '审核拟议变更',
    'Review proposed seller operation': '审核拟议操作',
    'Check the proposed change before approving.': '请在批准前核对变更内容。',
    'Operation review': '操作审核',
    'What will change': '即将变更的内容',
    'Images': '图片',
    'Photo changes': '照片变更',
    'Gallery photos': '相册照片',
    'No images are included in this proposal.': '此提案没有图片。',
    'View full-size verified image': '查看已验证的原尺寸图片',
    'Protected image for the selected change': '当前变更的受保护图片',
    'Complete proposal & technical details': '完整提案和技术详情',
    'All proposal text is data supplied by the shop or connected app. This is the full proposal, including fields not shown in the summary.': '提案中的文字由店铺或连接应用提供。此处包含完整提案及摘要中未列出的字段。',
    'Shop': '店铺',
    'Seller account': '卖家账号',
    'Connected app (unverified name)': '连接应用（名称未经验证）',
    'Review status': '审核状态',
    'Expires (your local time)': '到期时间（本地时间）',
    'Approval policy': '审批规则',
    'Operation ID': '操作 ID',
    'Client ID': '客户端 ID',
    'Internal tool': '内部工具',
    'Target': '变更对象',
    'Preview fingerprint': '预览指纹',
    'Complete proposal': '完整提案',
    'Image references': '图片引用',
    'Company currency change': '更改公司货币',
    'Changing the company currency changes the default for future catalog entries. Existing product prices and historical order currencies are not converted.': '更改公司货币会改变今后新增商品的默认货币。现有商品价格和历史订单货币不会换算。',
    'I understand that existing prices and historical orders will not be converted.': '我了解现有价格和历史订单的金额不会换算。',
    'Your decision': '你的决定',
    'The app must still apply the change after approval.': '批准后，发起应用还需应用这项变更。',
    'Open Seller Studio': '打开卖家工作台',
    'Review product creation': '审核新建商品',
    'Review product changes': '审核商品变更',
    'Review company changes': '审核公司设置变更',
    'Review stock adjustment': '审核库存调整',
    'Review order decision': '审核订单决定',
    'Review gallery photo addition': '审核新增相册照片',
    'Review main photo change': '审核主图变更',
    'Review image layout': '审核图片布局',
    'Review current gallery': '审核现有相册',
    'Check the current gallery before confirming.': '请在确认前核对当前相册。',
    'Confirm gallery photos': '确认相册照片',
    'Approve change': '批准变更',
    'Approve image change': '批准图片变更',
    'Approve main photo change': '批准更换主图',
    'Approve gallery addition': '批准新增相册照片',
    'Approve description change': '批准说明变更',
    'Reject': '拒绝',
    'Close': '关闭',
    'Try again': '重试',
    'Check status': '检查状态',
    'Retry image verification': '重新验证图片',
    'Approved': '已批准',
    'Rejected': '已拒绝',
    'Applied': '已应用',
    'Approved · Gallery confirmed': '已批准 · 相册已确认',
    'Approved · Waiting to be applied': '已批准 · 待应用',
    'Gallery approved': '相册已批准',
    'Gallery confirmed': '相册已确认',
    'Your decision was recorded. The current gallery stays as shown.': '已记录你的决定，当前相册将按所示保留。',
    'Return to {app} to apply this change.': '请返回 {app} 应用这项变更。',
    'Return to the requesting app to apply this change.': '请返回发起应用，应用这项变更。',
    'The connected app finished applying the approved operation.': '连接应用已应用这项批准的操作。',
    'No change was made.': '未做任何变更。',
    'Ask the connected app for a new preview.': '请在发起应用中生成新预览。',
    'Cancelled': '已取消',
    'Proposal conflicts with a newer change': '提案与较新的变更冲突',
    'Proposal changed': '提案已变更',
    'Could not be applied': '无法应用',
    'Return to the requesting app for details.': '请返回发起应用查看详情。',
    'Review result': '审核结果',
    'Decision status unknown': '决定状态待确认',
    'We could not confirm the result. Check the status before trying again.': '无法确认结果。请先检查状态，再决定是否重试。',
    'Read the currency warning and check the acknowledgment before approving.': '批准前请阅读货币变更提示，并勾选确认。',
    'Expired': '已过期',
    'Pending approval': '待审批',
    'Pending your decision': '等待你的决定',
    'Approving…': '正在批准…',
    'Rejecting…': '正在拒绝…',
    'Loading the proposal…': '正在加载提案…',
    'Proposal expired. Ask the connected app for a new preview.': '提案已过期，请在发起应用中生成新预览。',
    'Expires in less than 1 min': '不到 1 分钟后过期',
    'Expires in {minutes} min': '{minutes} 分钟后过期',
    'Sign in to review this proposal': '登录后审核此提案',
    'Sign in to Seller Studio to review this proposal.': '请登录卖家工作台审核此提案。',
    'Sign in to Seller Studio to review this proposal. No change has been approved.': '请登录卖家工作台审核此提案。此变更还未批准。',
    'The proposal is unavailable. Try again to load this preview.': '暂时无法读取提案。请重试以加载预览。',
    'The proposal is unavailable. Ask the connected app to prepare a new preview.': '无法读取提案，请在发起应用中生成新预览。',
    'Before': '变更前',
    'After': '变更后',
    'Current': '当前',
    'Changed': '已变更',
    'New value': '新值',
    'Current value': '当前值',
    'Not provided': '未提供',
    'None': '无',
    'Empty': '空白',
    'Unlimited': '不限',
    'Listed': '已上架',
    'Not listed': '未上架',
    'Name': '名称',
    'SKU': 'SKU',
    'Price': '价格',
    'Stock': '库存',
    'Availability': '上架状态',
    'Category': '分类',
    'Description': '说明',
    'Options': '选项',
    'Variant group': '规格组',
    'Variant label': '规格名称',
    'No changes to the fields shown here.': '此处显示的字段没有变化。',
    'Unchanged fields ({count})': '未变更的字段（{count} 项）',
    'Main product photo': '商品主图',
    'Main photo retained': '保留主图',
    'Product gallery': '商品相册',
    'No photo selected': '未选择照片',
    'Gallery photo {position}': '相册第 {position} 张照片',
    'Main photo · Gallery photo {position}': '主图 · 相册第 {position} 张',
    'Previous photo': '上一张照片',
    'Next photo': '下一张照片',
    '{photo} ({current} of {total})': '{photo}（第 {current}/{total} 张）',
    'Requested by {app} for {shop} as {account}': '由 {app} 发起，店铺为 {shop}，卖家账号为 {account}',
    'New resource': '新建对象',
    'LOW': '低风险',
    'MEDIUM': '中风险',
    'HIGH': '高风险',
    '{price} minor units ({currency})': '{price} 最小货币单位（{currency}）',
    '{currency} · scale not provided': '{currency} · 未提供小数位数',
    'Currency not provided': '未提供货币',
    'Inactive': '未启用',
    '{count} selections without labels. See the complete proposal.': '{count} 个选项没有标签。请查看完整提案。',
    'Image verification failed. Reload this review or reject the proposal.': '图片验证失败，请重新加载审核页或拒绝提案。',
    'Images verified {done}/{total}': '已验证 {done}/{total} 张图片',
    'Loading and verifying the exact image…': '正在加载并验证原图…',
    'Exact image verified.': '原图验证完成。',
    'Image verification failed. Retry the image, reload this review or reject the proposal.': '图片验证失败，可以单张重试、重新加载审核页或拒绝提案。',
    'Image verification failed. Retry to load and verify it again.': '图片验证失败，请重试加载和验证。',
    'Verification failed': '验证失败',
    'Retry this photo': '重试这张照片',
    'Retry {photo}': '重试{photo}',
    '{photo} · preview shown above': '{photo} · 预览见上方',
    'Current gallery: {count} photos. Confirming leaves the gallery and main photo as shown.': '当前相册有 {count} 张照片。确认后会保留这里显示的相册和主图。',
    'Confirm the current selection.': '确认当前照片。',
    'Add 1 gallery photo': '新增 1 张相册照片',
    'Add {count} gallery photos': '新增 {count} 张相册照片',
    'Approve adding 1 photo': '批准新增 1 张照片',
    'Approve adding {count} photos': '批准新增 {count} 张照片',
    'Gallery {before} → {after} photos · Main photo stays the same': '相册 {before} → {after} 张 · 保留主图',
    'Add one photo to the gallery. The main product photo stays the same.': '新增 1 张相册照片，保留商品主图。',
    'Add {count} photos to the gallery. The main product photo stays the same.': '新增 {count} 张相册照片，保留商品主图。',
    'Replace the main product photo.': '更换商品主图。',
    'Set the main product photo.': '设置商品主图。',
    'The new main photo is already in the gallery.': '新主图已在相册中。',
    'The new main photo also appears in the gallery.': '新主图也会在相册中显示。',
    'Replace the main photo': '更换主图',
    'Set the main photo': '设置主图',
    'The main product photo is removed.': '将移除商品主图。',
    '1 gallery photo position changes.': '调整 1 张相册照片的位置。',
    '{count} gallery photo positions change.': '调整 {count} 张相册照片的位置。',
    '1 gallery photo added.': '新增 1 张相册照片。',
    '{count} gallery photos added.': '新增 {count} 张相册照片。',
    '1 gallery photo removed.': '移除 1 张相册照片。',
    '{count} gallery photos removed.': '移除 {count} 张相册照片。',
    'Existing gallery photos reordered.': '调整已有相册照片的顺序。',
    'Remove the main photo': '移除主图',
    'The current gallery stays visible.': '当前相册会继续显示。',
    'Photos to add': '将新增的照片',
    'Current gallery photos': '当前相册照片',
    'Existing photos ({count})': '已有照片（{count} 张）',
    'Unchanged photos': '保留的照片',
    'Main product photo · {name}': '商品主图 · {name}',
    'Gallery · {name}': '相册 · {name}',
    'Shared photos from {name}': '来自 {name} 的共享照片',
    'Product photos · {name}': '商品照片 · {name}',
    'Not yet created.': '尚未建立。',
    'Did not exist before this change.': '变更前不存在。',
    'Removed by this change.': '会随此变更移除。',
    'Options: {options}': '选项：{options}',
    'Options: none': '选项：无',
    'The main photo is hidden from shoppers.': '买家看不到商品主图。',
    'Shopper gallery in order:': '店面相册显示顺序：',
    'Language': '语言',
    'Theme': '主题',
    'System': '跟随系统',
    'Light': '浅色',
    'Dark': '深色',
  });

  function t(template, values = {}) {
    const message = language === 'zh-CN' && Object.hasOwn(zh, template) ? zh[template] : template;
    return message.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : placeholder);
  }

  function applyTheme() {
    const root = document.documentElement;
    root.dataset.themePreference = theme;
    root.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
    const field = document.querySelector('#review-theme');
    if (field) field.value = theme;
  }

  function applyReviewLanguage() {
    document.documentElement.lang = language;
    document.querySelectorAll('[data-review-copy]').forEach(node => {
      node.dataset.reviewCopy ||= node.textContent;
      node.textContent = t(node.dataset.reviewCopy);
    });
    for (const [attribute, key, selector] of [['aria-label', 'reviewAria', '[data-review-aria]'], ['alt', 'reviewAlt', '[data-review-alt]']]) {
      document.querySelectorAll(selector).forEach(node => {
        node.dataset[key] ||= node.getAttribute(attribute);
        node.setAttribute(attribute, t(node.dataset[key]));
      });
    }
    const field = document.querySelector('#review-language');
    if (field) field.value = language;
  }

  function setReviewLocale(value) {
    if (!['en', 'zh-CN', 'zh-Hans'].includes(value)) return;
    language = supportedLanguage(value);
    save(languageKey, language === 'zh-CN' ? 'zh-Hans' : 'en');
    applyReviewLanguage();
  }

  document.documentElement.lang = language;
  applyTheme();
  systemTheme.addEventListener('change', applyTheme);
  window.addEventListener('storage', event => {
    if (event.key === themeKey || event.key === null) {
      theme = supportedTheme(read(themeKey));
      applyTheme();
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    applyReviewLanguage();
    applyTheme();
    document.querySelector('#review-theme')?.addEventListener('change', event => {
      theme = supportedTheme(event.target.value);
      save(themeKey, theme);
      applyTheme();
    });
  }, { once: true });
  window.operationReviewLanguage = Object.freeze({ t, reviewLocale: () => language, applyReviewLanguage, setReviewLocale });
})();
