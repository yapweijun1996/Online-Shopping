import { apiUrl } from '../shared/base-path.js';
import { messages, t, translate } from '../shared/i18n.js';

const keys = ['integrationsHeading','integrationsIntro','integrationsUnconfigured','integrationsContract','integrationsRisk','integrationsPrepared','integrationsShipping','integrationsMessaging'];
const copy = {
  en: ['Delivery & messaging','Preparation only. Providers are not connected. Shipments, messages and QR pairing are unavailable.','Not configured','Official account contract required','Unofficial option · separate risk review required','Offline foundation · sandbox and provider approval pending','Delivery provider','Messaging provider'],
  ms: ['Penghantaran & pemesejan','Persediaan sahaja. Penyedia belum disambungkan. Penghantaran, mesej dan pemadanan QR tidak tersedia.','Belum dikonfigurasi','Kontrak akaun rasmi diperlukan','Pilihan tidak rasmi · semakan risiko berasingan diperlukan','Asas luar talian · kelulusan sandbox dan penyedia belum selesai','Penyedia penghantaran','Penyedia pemesejan'],
  'zh-Hans': ['快递与消息','仅为集成准备。提供商尚未连接，无法创建物流、发送消息或进行 QR 配对。','未配置','需要官方账号契约','非官方选项 · 需要单独风险审查','离线基础 · 沙盒验证与提供商审批待完成','快递提供商','消息提供商'],
  vi: ['Giao hàng & nhắn tin','Chỉ chuẩn bị tích hợp. Chưa kết nối nhà cung cấp. Không thể tạo giao hàng, gửi tin nhắn hoặc ghép nối QR.','Chưa cấu hình','Cần hợp đồng tài khoản chính thức','Tùy chọn không chính thức · cần đánh giá rủi ro riêng','Nền tảng ngoại tuyến · chờ xác minh sandbox và phê duyệt','Nhà cung cấp giao hàng','Nhà cung cấp tin nhắn'],
  th: ['การจัดส่งและข้อความ','เตรียมการเชื่อมต่อเท่านั้น ผู้ให้บริการยังไม่ได้เชื่อมต่อ จึงไม่สามารถจัดส่ง ส่งข้อความ หรือจับคู่ QR ได้','ยังไม่ได้กำหนดค่า','ต้องมีสัญญาบัญชีทางการ','ตัวเลือกไม่เป็นทางการ · ต้องตรวจสอบความเสี่ยงแยกต่างหาก','พื้นฐานออฟไลน์ · รอทดสอบ sandbox และการอนุมัติ','ผู้ให้บริการจัดส่ง','ผู้ให้บริการข้อความ'],
  ja: ['配送とメッセージ','連携の準備のみです。事業者は未接続です。配送作成、メッセージ送信、QR ペアリングは利用できません。','未設定','公式アカウントの契約が必要','非公式の選択肢 · 個別のリスク審査が必要','オフライン基盤 · sandbox 検証と承認は未完了','配送事業者','メッセージ事業者'],
  ko: ['배송 및 메시지','연동 준비 단계입니다. 제공업체가 연결되지 않아 배송 생성, 메시지 전송, QR 페어링을 사용할 수 없습니다.','미설정','공식 계정 계약 필요','비공식 옵션 · 별도 위험 검토 필요','오프라인 기반 · sandbox 검증 및 승인 대기','배송 제공업체','메시지 제공업체'],
};
for (const [locale, values] of Object.entries(copy)) Object.assign(messages[locale], Object.fromEntries(keys.map((key, index) => [key, values[index]])));

export function mountIntegrations(root, { csrfToken, onUnauthorized }) {
  const section = document.createElement('section'); section.className = 'settings-card integration-status-card';
  section.innerHTML = '<h2 data-i18n="integrationsHeading"></h2><p data-i18n="integrationsIntro"></p><p class="integration-load-status" role="status"></p><div class="integration-providers"></div><button type="button" class="secondary-button" data-i18n="retry" hidden></button>';
  root.append(section);
  const line = section.querySelector('[role="status"]'), list = section.querySelector('.integration-providers'), retry = section.querySelector('button');
  let data, epoch = 0, statusKey = 'loading';
  const identity = csrfToken();
  const current = request => section.isConnected && request === epoch && csrfToken() === identity;
  function render() {
    translate(section); line.textContent = statusKey ? t(statusKey) : '';
    list.replaceChildren();
    for (const provider of data?.providers || []) {
      const card = document.createElement('article'); card.className = 'integration-provider';
      const title = document.createElement('h3'); title.textContent = provider.name;
      const state = document.createElement('strong'); state.textContent = t('integrationsUnconfigured'); state.dataset.provider = provider.id;
      const category = document.createElement('p'); category.textContent = t(provider.category === 'shipping' ? 'integrationsShipping' : 'integrationsMessaging');
      const readiness = document.createElement('p'); readiness.textContent = t(provider.contract === 'PRIVATE_CONTRACT_REQUIRED' ? 'integrationsContract' : provider.contract === 'RISK_REVIEW_REQUIRED' ? 'integrationsRisk' : 'integrationsPrepared');
      card.append(title, state, category, readiness); list.append(card);
    }
  }
  async function load() {
    const request = ++epoch; statusKey = 'loading'; retry.hidden = true; render();
    try {
      const response = await fetch(apiUrl('v1/seller/integrations'), { cache: 'no-store' });
      if (!current(request)) return;
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json(); if (!current(request)) return;
      data = result; statusKey = ''; render();
    } catch { if (current(request)) { statusKey = 'networkError'; retry.hidden = false; render(); } }
  }
  retry.addEventListener('click', load); load();
  return { refreshLocale: render };
}
