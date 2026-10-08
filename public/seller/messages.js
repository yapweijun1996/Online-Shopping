import { messages, t, translate, formatDate } from '../shared/i18n.js';
import { confirmModal } from '../shared/modal.js';
import { request } from './settings.js';

const keys = ['msgHeading', 'msgReplies', 'msgAttention', 'msgEmptyReplies', 'msgEmptyAttention', 'msgLoading', 'msgError', 'msgMore', 'msgUnreadOnly', 'msgNoOrder', 'msgOpenWhatsApp', 'msgUnread', 'msgRead', 'msgReconcile', 'msgFailed', 'msgSentAction', 'msgResend', 'msgSentConfirm', 'msgResendConfirm', 'msgChanged', 'msgSubmitted', 'msgConfirmed', 'msgRejected', 'msgShipped', 'msgPending', 'msgLeased', 'msgRetry', 'msgAccepted', 'msgDelivered', 'msgSeen', 'msgSent', 'msgUnknown', 'msgBadge', 'msgOrderHeading', 'msgReload'];
const copy = {
  en: ['Messages', 'Replies', 'Needs attention', 'No replies yet.', 'No messages need attention.', 'Loading messages…', 'Could not load or update messages. Try again.', 'Load more', 'Unread only', 'No matching order', 'Open WhatsApp to see this message', 'Unread', 'Mark as read', 'We could not confirm whether WhatsApp sent this. Check WhatsApp Manager before deciding.', 'WhatsApp did not accept this message.', 'I checked: it was sent', 'Send again', 'Have you checked WhatsApp Manager and confirmed that this message was sent?', 'Send again? If it was already delivered, the buyer may receive this message twice.', 'This message changed. Reload.', 'Order submitted', 'Order confirmed', 'Order rejected', 'Order shipped', 'Waiting to send', 'Sending', 'Waiting to retry', 'Accepted by WhatsApp', 'Delivered', 'Read by buyer', 'Confirmed sent', 'Status unavailable', 'Messages needing attention', 'WhatsApp messages', 'Reload'],
  ms: ['Mesej', 'Balasan', 'Perlu perhatian', 'Belum ada balasan.', 'Tiada mesej memerlukan perhatian.', 'Memuatkan mesej…', 'Tidak dapat memuatkan atau mengemas kini mesej. Cuba lagi.', 'Muat lagi', 'Belum dibaca sahaja', 'Tiada pesanan sepadan', 'Buka WhatsApp untuk melihat mesej ini', 'Belum dibaca', 'Tandakan dibaca', 'Kami tidak dapat memastikan sama ada WhatsApp menghantarnya. Semak WhatsApp Manager sebelum membuat keputusan.', 'WhatsApp tidak menerima mesej ini.', 'Saya sudah semak: telah dihantar', 'Hantar semula', 'Adakah anda telah menyemak WhatsApp Manager dan memastikan mesej ini dihantar?', 'Hantar semula? Jika sudah diterima, pembeli mungkin menerima mesej ini dua kali.', 'Mesej ini telah berubah. Muat semula.', 'Pesanan dihantar', 'Pesanan disahkan', 'Pesanan ditolak', 'Pesanan dikirim', 'Menunggu penghantaran', 'Sedang menghantar', 'Menunggu percubaan semula', 'Diterima oleh WhatsApp', 'Sampai kepada pembeli', 'Dibaca oleh pembeli', 'Penghantaran disahkan', 'Status tidak tersedia', 'Mesej yang memerlukan perhatian', 'Mesej WhatsApp', 'Muat semula'],
  'zh-Hans': ['消息', '买家回复', '需要处理', '暂无回复。', '没有需要处理的消息。', '正在加载消息…', '无法加载或更新消息，请重试。', '加载更多', '仅看未读', '没有匹配的订单', '请打开 WhatsApp 查看此消息', '未读', '标为已读', '无法确认 WhatsApp 是否已发送此消息。请先在 WhatsApp Manager 中核实，再决定如何处理。', 'WhatsApp 未接受此消息。', '已核实：消息已发送', '重新发送', '您是否已在 WhatsApp Manager 中核实此消息已发送？', '要重新发送吗？如果消息实际已送达，买家可能收到两次。', '此消息已发生变化，请重新加载。', '订单已提交', '订单已确认', '订单已拒绝', '订单已发货', '等待发送', '正在发送', '等待重试', 'WhatsApp 已接受', '已送达', '买家已读', '已核实发送', '状态不可用', '需要处理的消息', 'WhatsApp 消息', '重新加载'],
  vi: ['Tin nhắn', 'Phản hồi', 'Cần xử lý', 'Chưa có phản hồi.', 'Không có tin nhắn cần xử lý.', 'Đang tải tin nhắn…', 'Không thể tải hoặc cập nhật tin nhắn. Hãy thử lại.', 'Tải thêm', 'Chỉ chưa đọc', 'Không có đơn hàng phù hợp', 'Mở WhatsApp để xem tin nhắn này', 'Chưa đọc', 'Đánh dấu đã đọc', 'Chúng tôi chưa thể xác nhận WhatsApp đã gửi hay chưa. Kiểm tra WhatsApp Manager trước khi quyết định.', 'WhatsApp không chấp nhận tin nhắn này.', 'Đã kiểm tra: đã gửi', 'Gửi lại', 'Bạn đã kiểm tra WhatsApp Manager và xác nhận tin nhắn này đã được gửi chưa?', 'Gửi lại? Nếu đã được giao, người mua có thể nhận tin nhắn này hai lần.', 'Tin nhắn đã thay đổi. Hãy tải lại.', 'Đơn hàng đã gửi', 'Đơn hàng đã xác nhận', 'Đơn hàng bị từ chối', 'Đơn hàng đã xuất kho', 'Chờ gửi', 'Đang gửi', 'Chờ thử lại', 'WhatsApp đã chấp nhận', 'Đã giao', 'Người mua đã đọc', 'Đã xác nhận gửi', 'Không có trạng thái', 'Tin nhắn cần xử lý', 'Tin nhắn WhatsApp', 'Tải lại'],
  th: ['ข้อความ', 'ข้อความตอบกลับ', 'ต้องดำเนินการ', 'ยังไม่มีข้อความตอบกลับ', 'ไม่มีข้อความที่ต้องดำเนินการ', 'กำลังโหลดข้อความ…', 'โหลดหรืออัปเดตข้อความไม่ได้ โปรดลองอีกครั้ง', 'โหลดเพิ่มเติม', 'เฉพาะที่ยังไม่ได้อ่าน', 'ไม่มีคำสั่งซื้อที่ตรงกัน', 'เปิด WhatsApp เพื่อดูข้อความนี้', 'ยังไม่ได้อ่าน', 'ทำเครื่องหมายว่าอ่านแล้ว', 'เราไม่สามารถยืนยันได้ว่า WhatsApp ส่งข้อความนี้แล้วหรือไม่ โปรดตรวจสอบใน WhatsApp Manager ก่อนตัดสินใจ', 'WhatsApp ไม่ยอมรับข้อความนี้', 'ตรวจสอบแล้ว: ส่งแล้ว', 'ส่งอีกครั้ง', 'คุณตรวจสอบใน WhatsApp Manager และยืนยันว่าข้อความนี้ส่งแล้วหรือยัง?', 'ส่งอีกครั้งหรือไม่? หากส่งถึงแล้ว ผู้ซื้ออาจได้รับข้อความนี้สองครั้ง', 'ข้อความนี้เปลี่ยนแปลงแล้ว โปรดโหลดใหม่', 'ส่งคำสั่งซื้อแล้ว', 'ยืนยันคำสั่งซื้อแล้ว', 'ปฏิเสธคำสั่งซื้อแล้ว', 'จัดส่งคำสั่งซื้อแล้ว', 'รอส่ง', 'กำลังส่ง', 'รอลองใหม่', 'WhatsApp ยอมรับแล้ว', 'ส่งถึงแล้ว', 'ผู้ซื้ออ่านแล้ว', 'ยืนยันว่าส่งแล้ว', 'ไม่ทราบสถานะ', 'ข้อความที่ต้องดำเนินการ', 'ข้อความ WhatsApp', 'โหลดใหม่'],
  ja: ['メッセージ', '返信', '対応が必要', '返信はまだありません。', '対応が必要なメッセージはありません。', 'メッセージを読み込み中…', 'メッセージの読み込みまたは更新に失敗しました。再試行してください。', 'さらに読み込む', '未読のみ', '該当する注文なし', 'このメッセージは WhatsApp で確認してください', '未読', '既読にする', 'WhatsApp が送信したか確認できませんでした。判断する前に WhatsApp Manager で確認してください。', 'WhatsApp はこのメッセージを受け付けませんでした。', '確認済み：送信されました', '再送する', 'WhatsApp Manager でこのメッセージが送信済みであることを確認しましたか？', '再送しますか？すでに届いている場合、購入者に同じメッセージが二度届く可能性があります。', 'このメッセージは変更されました。再読み込みしてください。', '注文が送信されました', '注文が確認されました', '注文が却下されました', '注文が発送されました', '送信待ち', '送信中', '再試行待ち', 'WhatsApp が受付済み', '配信済み', '購入者が既読', '送信確認済み', '状態を確認できません', '対応が必要なメッセージ', 'WhatsApp メッセージ', '再読み込み'],
  ko: ['메시지', '답장', '처리 필요', '아직 답장이 없습니다.', '처리할 메시지가 없습니다.', '메시지 불러오는 중…', '메시지를 불러오거나 변경할 수 없습니다. 다시 시도하세요.', '더 보기', '읽지 않은 항목만', '일치하는 주문 없음', 'WhatsApp에서 이 메시지를 확인하세요', '읽지 않음', '읽음으로 표시', 'WhatsApp이 전송했는지 확인할 수 없습니다. 결정하기 전에 WhatsApp Manager에서 확인하세요.', 'WhatsApp이 이 메시지를 수락하지 않았습니다.', '확인 완료: 전송됨', '다시 보내기', 'WhatsApp Manager에서 이 메시지가 전송되었는지 확인하셨나요?', '다시 보낼까요? 이미 전달되었다면 구매자가 이 메시지를 두 번 받을 수 있습니다.', '메시지가 변경되었습니다. 새로 불러오세요.', '주문 제출됨', '주문 확인됨', '주문 거절됨', '주문 발송됨', '전송 대기', '전송 중', '재시도 대기', 'WhatsApp 수락됨', '전달됨', '구매자가 읽음', '전송 확인됨', '상태 확인 불가', '처리할 메시지', 'WhatsApp 메시지', '새로 불러오기'],
};
for (const [locale, values] of Object.entries(copy)) Object.assign(messages[locale], Object.fromEntries(keys.map((key, index) => [key, values[index]])));

const changeEvent = 'sellermessageschange';
const kindKeys = { ORDER_SUBMITTED: 'msgSubmitted', ORDER_CONFIRMED: 'msgConfirmed', ORDER_REJECTED: 'msgRejected', ORDER_SHIPPED: 'msgShipped' };
const statusKeys = { QUEUED: 'msgPending', SENDING: 'msgLeased', PENDING: 'msgPending', LEASED: 'msgLeased', RETRY: 'msgRetry', ACCEPTED: 'msgAccepted', DELIVERED: 'msgDelivered', READ: 'msgSeen', SENT: 'msgSent', FAILED: 'msgFailed', RECONCILE: 'msgReconcile' };
function element(tag, key, className = '') {
  const node = document.createElement(tag);
  if (key) { node.dataset.i18n = key; node.textContent = t(key); }
  if (className) node.className = className;
  return node;
}
function button(key, click) {
  const node = element('button', key, 'secondary-button'); node.type = 'button';
  node.addEventListener('click', click); return node;
}
function setLine(line, key) { line.dataset.i18n = key; line.textContent = key ? t(key) : ''; }
function statusLine() {
  const line = element('p', null, 'message'); line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite'); return line;
}
async function read(path, onUnauthorized) {
  const response = await fetch(path, { cache: 'no-store' });
  if (response.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
  if (!response.ok) throw new Error('request');
  return response.json();
}
function notifyChange() { document.dispatchEvent(new Event(changeEvent)); }
function time(value) {
  const node = element('time', null, 'msg-time');
  try { node.textContent = formatDate(value); node.dateTime = value; } catch { node.textContent = '—'; }
  return node;
}
function orderLink(item) {
  const node = element(item.orderId ? 'a' : 'span', item.orderId ? null : 'msgNoOrder', 'msg-order');
  if (item.orderId) { node.textContent = item.orderNo || t('msgNoOrder'); node.href = `#orders/${encodeURIComponent(item.orderId)}`; }
  return node;
}
function replyRow(item, markRead) {
  const row = element('li', null, `msg-row${item.read ? '' : ' msg-unread'}`);
  row.append(orderLink(item), time(item.receivedAt));
  const body = element('p', item.kind === 'TEXT' ? null : 'msgOpenWhatsApp', 'msg-body');
  if (item.kind === 'TEXT') body.textContent = item.body || '';
  row.append(body);
  if (!item.read) {
    row.append(element('strong', 'msgUnread', 'msg-unread-label'));
    row.append(button('msgRead', event => markRead(item, event.currentTarget)));
  }
  return row;
}
function sentRow(item) {
  const row = element('li', null, 'msg-row');
  row.append(orderLink(item), element('strong', kindKeys[item.kind] || 'msgUnknown'), element('p', statusKeys[item.status] || 'msgUnknown'), time(item.updatedAt || item.createdAt));
  return row;
}
async function markReply(item, csrfToken, onUnauthorized) {
  await request('POST', `/api/v1/seller/messages/replies/${encodeURIComponent(item.id)}/read`, {}, csrfToken, onUnauthorized);
}

export function startMessageBadge({ badge, navItem, csrfToken, onUnauthorized }) {
  const identity = csrfToken();
  let active = true, available = false, timer = null, sequence = 0, count = 0;
  navItem.hidden = true; badge.hidden = true;
  function dispose() {
    active = false; ++sequence; clearTimeout(timer); timer = null;
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener(changeEvent, refresh);
    navItem.hidden = true; badge.hidden = true;
  }
  function current(ticket) {
    if (csrfToken() !== identity) dispose();
    return active && ticket === sequence;
  }
  function refreshLocale() {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.setAttribute('aria-label', `${t('msgBadge')}: ${count}`);
    badge.hidden = count === 0;
  }
  async function refresh() {
    clearTimeout(timer); timer = null;
    const ticket = ++sequence;
    if (!current(ticket) || !available || document.hidden) return;
    try {
      const data = await read('/api/v1/seller/messages/summary', () => { if (current(ticket)) onUnauthorized(); });
      if (!current(ticket)) return;
      count = data.unreadReplies + data.reconcile + data.failed; refreshLocale();
    } catch { /* Keep the last count until the next refresh. */ }
    if (current(ticket) && !document.hidden) timer = setTimeout(refresh, 60000);
  }
  function visibility() { refresh(); }
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener(changeEvent, refresh);
  const ownsConnection = () => {
    if (csrfToken() !== identity) dispose();
    return active;
  };
  read('/api/v1/seller/integrations/whatsapp', () => { if (ownsConnection()) onUnauthorized(); }).then(data => {
    if (!ownsConnection() || data.available !== true) return;
    available = true; navItem.hidden = false; refresh();
  }).catch(() => {});
  return { refresh, refreshLocale, dispose };
}

export function mountMessages(root, { csrfToken, onUnauthorized }) {
  root.replaceChildren();
  const identity = csrfToken();
  let active = true;
  const container = element('div', null, 'msg-page'); root.append(container);
  const current = () => active && container.isConnected && csrfToken() === identity;
  const unauthorized = () => { if (current()) onUnauthorized(); };
  function mountList(type, heading, emptyKey) {
    const section = element('section', null, 'settings-card msg-section');
    const title = element('h2', heading); section.append(title);
    const unread = element('input'); unread.type = 'checkbox';
    if (type === 'replies') {
      const label = element('label', null, 'msg-filter'); label.append(unread, element('span', 'msgUnreadOnly')); section.append(label);
      unread.addEventListener('change', () => load(true));
    }
    const line = statusLine(), actionLine = statusLine(), list = element('ul', null, 'msg-list');
    const more = button('msgMore', () => load(false)); more.hidden = true;
    const retry = button('msgReload', () => load(true)); retry.hidden = true;
    section.append(line, actionLine, list, more, retry); container.append(section);
    let items = [], nextOffset = null, epoch = 0, loading = false, error = false;
    const busy = new Set();
    const valid = ticket => current() && ticket === epoch;
    function render() {
      list.replaceChildren(...items.map(item => {
        if (type === 'replies') {
          const row = replyRow(item, markRead);
          row.querySelectorAll('button').forEach(control => { control.disabled = busy.has(item.id); });
          return row;
        }
        const row = sentRow(item), actions = element('div', null, 'msg-actions');
        if (item.status === 'RECONCILE') actions.append(button('msgSentAction', event => resolve(item, 'SENT', event.currentTarget)));
        if (['RECONCILE', 'FAILED'].includes(item.status)) actions.append(button('msgResend', event => resolve(item, 'RESEND', event.currentTarget)));
        actions.querySelectorAll('button').forEach(control => { control.disabled = busy.has(item.id); });
        row.append(actions); return row;
      }));
      setLine(line, loading ? 'msgLoading' : error ? 'msgError' : items.length ? '' : emptyKey);
      more.hidden = nextOffset === null; more.disabled = loading; retry.hidden = !error;
    }
    async function load(reset) {
      const ticket = ++epoch;
      if (reset) { items = []; nextOffset = null; }
      loading = true; error = false; render();
      const params = new URLSearchParams({ limit: '30', offset: String(reset ? 0 : nextOffset) });
      if (type === 'replies' && unread.checked) params.set('unread', '1');
      try {
        const page = await read(`/api/v1/seller/messages/${type}?${params}`, () => { if (valid(ticket)) unauthorized(); });
        if (!valid(ticket)) return;
        items = reset ? page.items : [...items, ...page.items]; nextOffset = page.nextOffset;
      } catch (failure) { if (valid(ticket) && failure.message !== 'unauthorized') error = true; }
      if (valid(ticket)) { loading = false; render(); }
    }
    async function markRead(item, control) {
      const ticket = epoch; if (control.disabled || busy.has(item.id) || !valid(ticket)) return;
      busy.add(item.id);
      control.disabled = true; setLine(actionLine, '');
      try {
        await markReply(item, csrfToken, () => { if (valid(ticket)) unauthorized(); });
        if (!current()) return;
        notifyChange(); await load(true);
      } catch (failure) { if (valid(ticket) && failure.message !== 'unauthorized') setLine(actionLine, 'msgError'); }
      finally { busy.delete(item.id); if (current()) render(); }
    }
    async function resolve(item, resolution, control) {
      const ticket = epoch; if (control.disabled || busy.has(item.id) || !valid(ticket)) return;
      busy.add(item.id);
      const controls = control.parentNode.querySelectorAll('button'); controls.forEach(node => { node.disabled = true; });
      try {
        const accepted = await confirmModal(t(resolution === 'RESEND' ? 'msgResendConfirm' : 'msgSentConfirm'), { title: t(resolution === 'RESEND' ? 'msgResend' : 'msgSentAction'), confirmLabel: t(resolution === 'RESEND' ? 'msgResend' : 'msgSentAction') });
        if (!accepted || !valid(ticket)) return;
        setLine(actionLine, '');
        await request('POST', `/api/v1/seller/messages/outbox/${encodeURIComponent(item.id)}/resolve`, { resolution }, csrfToken, () => { if (valid(ticket)) unauthorized(); });
        if (!current()) return;
        notifyChange(); await load(true);
      } catch (failure) {
        if (!valid(ticket) || failure.message === 'unauthorized') return;
        setLine(actionLine, failure.code === 'NOT_RESOLVABLE' ? 'msgChanged' : 'msgError');
        if (failure.code === 'NOT_RESOLVABLE') { notifyChange(); await load(true); }
      } finally { busy.delete(item.id); if (current()) render(); }
    }
    load(true);
    return { refreshLocale() { translate(section); render(); }, dispose() { ++epoch; } };
  }
  const lists = [mountList('replies', 'msgReplies', 'msgEmptyReplies'), mountList('outbox', 'msgAttention', 'msgEmptyAttention')];
  return { refreshLocale() { lists.forEach(list => list.refreshLocale()); }, dispose() { active = false; lists.forEach(list => list.dispose()); } };
}

export function mountOrderMessages(root, { orderId, csrfToken, onUnauthorized }) {
  const identity = csrfToken();
  let active = true, epoch = 0;
  const section = element('section', null, 'order-detail-group msg-section'); section.hidden = true; root.append(section);
  const current = ticket => active && section.isConnected && ticket === epoch && csrfToken() === identity;
  async function load() {
    const ticket = ++epoch;
    try {
      const data = await read(`/api/v1/seller/orders/${encodeURIComponent(orderId)}/messages`, () => { if (current(ticket)) onUnauthorized(); });
      if (!current(ticket)) return;
      section.hidden = !data.messages.length && !data.replies.length;
      section.replaceChildren();
      if (section.hidden) return;
      const list = element('ul', null, 'msg-list'), line = statusLine();
      section.append(element('h3', 'msgOrderHeading'), list, line);
      list.append(...data.messages.map(sentRow), ...data.replies.map(item => replyRow(item, async (reply, control) => {
        if (control.disabled || !current(ticket)) return;
        control.disabled = true; setLine(line, '');
        try {
          await markReply(reply, csrfToken, () => { if (current(ticket)) onUnauthorized(); });
          if (current(ticket)) { notifyChange(); await load(); }
        } catch (failure) { if (current(ticket) && failure.message !== 'unauthorized') setLine(line, 'msgError'); }
        finally { if (current(ticket)) control.disabled = false; }
      })));
    } catch (failure) {
      if (current(ticket) && failure.message !== 'unauthorized') {
        section.hidden = false; section.replaceChildren(element('h3', 'msgOrderHeading'), element('p', 'msgError'), button('msgReload', load));
      }
    }
  }
  load();
  return { dispose() { active = false; ++epoch; section.remove(); } };
}
