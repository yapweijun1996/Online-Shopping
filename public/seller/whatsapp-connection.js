import { apiUrl } from '../shared/base-path.js';
import { messages, t, translate, formatDate } from '../shared/i18n.js';
import { confirmModal } from '../shared/modal.js';

const keys = ['waHeading', 'waIntro', 'waCallback', 'waCopy', 'waCopied', 'waSelectCopy', 'waSandbox', 'waProduction', 'waConnected', 'waNotConnected', 'waError', 'waSecretHint', 'waPhone', 'waName', 'waChecked', 'waNever', 'waVerifyToken', 'waWebhookHelp', 'waAccessToken', 'waAppSecret', 'waPhoneId', 'waBusinessId', 'waConnect', 'waUpdate', 'waDisconnect', 'waDisconnectConfirm', 'waRejected', 'waProviderUnavailable', 'waRateLimited', 'waUnavailable', 'waForbidden', 'waInvalid', 'waFailed'];
const copy = {
  en: ['WhatsApp connection', 'Connect your WhatsApp Business account using your Meta app credentials.', 'Callback URL', 'Copy', 'Copied.', 'Select the text and copy it manually.', 'Sandbox', 'Production', 'Connected', 'Not connected', 'Error', 'Saved access token', 'Display phone number', 'Verified name', 'Last checked', 'Not checked yet', 'Verify token', 'Paste the callback URL and this token into the webhook settings of your Meta app.', 'Access token', 'App secret', 'Phone number ID', 'Business account ID', 'Connect', 'Update', 'Disconnect', 'Disconnect this WhatsApp account? You will need to enter the credentials again to reconnect.', 'Meta rejected the credentials. Check them and try again.', 'Meta is temporarily unavailable. Try again later.', 'Too many attempts. Try again later.', 'Connections are currently unavailable.', 'You do not have permission to change this connection.', 'Check this field. IDs must contain 5–32 digits; credentials are required.', 'Could not save the connection. Try again.'],
  ms: ['Sambungan WhatsApp', 'Sambungkan akaun WhatsApp Business anda menggunakan kelayakan aplikasi Meta anda.', 'URL panggil balik', 'Salin', 'Disalin.', 'Pilih teks dan salin secara manual.', 'Persekitaran ujian', 'Persekitaran produksi', 'Disambungkan', 'Belum disambungkan', 'Ralat', 'Token akses tersimpan', 'Nombor telefon paparan', 'Nama disahkan', 'Semakan terakhir', 'Belum disemak', 'Token pengesahan', 'Tampal URL panggil balik dan token ini dalam tetapan webhook aplikasi Meta anda.', 'Token akses', 'Rahsia aplikasi', 'ID nombor telefon', 'ID akaun perniagaan', 'Sambungkan', 'Kemas kini', 'Putuskan sambungan', 'Putuskan sambungan akaun WhatsApp ini? Anda perlu memasukkan kelayakan semula untuk menyambung semula.', 'Meta menolak kelayakan. Semak dan cuba lagi.', 'Meta tidak tersedia buat sementara waktu. Cuba lagi kemudian.', 'Terlalu banyak percubaan. Cuba lagi kemudian.', 'Sambungan tidak tersedia buat masa ini.', 'Anda tiada kebenaran untuk mengubah sambungan ini.', 'Semak medan ini. ID mesti mengandungi 5–32 digit; kelayakan diperlukan.', 'Tidak dapat menyimpan sambungan. Cuba lagi.'],
  'zh-Hans': ['WhatsApp 连接', '使用 Meta 应用凭据连接您的 WhatsApp Business 账号。', '回调网址', '复制', '已复制。', '请选择文字并手动复制。', '沙盒环境', '生产环境', '已连接', '未连接', '错误', '已保存的访问令牌', '显示电话号码', '已验证名称', '上次检查', '尚未检查', '验证令牌', '请将回调网址和此令牌粘贴到 Meta 应用的 webhook 设置中。', '访问令牌', '应用密钥', '电话号码 ID', '商业账号 ID', '连接', '更新', '断开连接', '要断开此 WhatsApp 账号吗？重新连接时需要再次输入凭据。', 'Meta 拒绝了凭据，请检查后重试。', 'Meta 暂时不可用，请稍后重试。', '尝试次数过多，请稍后重试。', '目前无法使用连接功能。', '您无权更改此连接。', '请检查此字段。ID 必须为 5–32 位数字；凭据不能为空。', '无法保存连接，请重试。'],
  vi: ['Kết nối WhatsApp', 'Kết nối tài khoản WhatsApp Business bằng thông tin xác thực ứng dụng Meta của bạn.', 'URL gọi lại', 'Sao chép', 'Đã sao chép.', 'Chọn văn bản và sao chép thủ công.', 'Môi trường thử nghiệm', 'Môi trường chính thức', 'Đã kết nối', 'Chưa kết nối', 'Lỗi', 'Mã truy cập đã lưu', 'Số điện thoại hiển thị', 'Tên đã xác minh', 'Kiểm tra lần cuối', 'Chưa kiểm tra', 'Mã xác minh', 'Dán URL gọi lại và mã này vào cài đặt webhook của ứng dụng Meta.', 'Mã truy cập', 'Khóa bí mật ứng dụng', 'ID số điện thoại', 'ID tài khoản doanh nghiệp', 'Kết nối', 'Cập nhật', 'Ngắt kết nối', 'Ngắt kết nối tài khoản WhatsApp này? Bạn sẽ cần nhập lại thông tin xác thực để kết nối lại.', 'Meta từ chối thông tin xác thực. Hãy kiểm tra và thử lại.', 'Meta tạm thời không khả dụng. Hãy thử lại sau.', 'Quá nhiều lần thử. Hãy thử lại sau.', 'Hiện không thể sử dụng kết nối.', 'Bạn không có quyền thay đổi kết nối này.', 'Kiểm tra trường này. ID phải có 5–32 chữ số; cần nhập thông tin xác thực.', 'Không thể lưu kết nối. Hãy thử lại.'],
  th: ['การเชื่อมต่อ WhatsApp', 'เชื่อมต่อบัญชี WhatsApp Business ด้วยข้อมูลรับรองแอป Meta ของคุณ', 'URL เรียกกลับ', 'คัดลอก', 'คัดลอกแล้ว', 'เลือกข้อความแล้วคัดลอกด้วยตนเอง', 'สภาพแวดล้อมทดสอบ', 'สภาพแวดล้อมใช้งานจริง', 'เชื่อมต่อแล้ว', 'ยังไม่ได้เชื่อมต่อ', 'ข้อผิดพลาด', 'โทเค็นการเข้าถึงที่บันทึกไว้', 'หมายเลขโทรศัพท์ที่แสดง', 'ชื่อที่ยืนยันแล้ว', 'ตรวจสอบล่าสุด', 'ยังไม่ได้ตรวจสอบ', 'โทเค็นยืนยัน', 'วาง URL เรียกกลับและโทเค็นนี้ในการตั้งค่า webhook ของแอป Meta ของคุณ', 'โทเค็นการเข้าถึง', 'รหัสลับแอป', 'ID หมายเลขโทรศัพท์', 'ID บัญชีธุรกิจ', 'เชื่อมต่อ', 'อัปเดต', 'ตัดการเชื่อมต่อ', 'ตัดการเชื่อมต่อบัญชี WhatsApp นี้หรือไม่? คุณต้องป้อนข้อมูลรับรองอีกครั้งเพื่อเชื่อมต่อใหม่', 'Meta ปฏิเสธข้อมูลรับรอง โปรดตรวจสอบแล้วลองอีกครั้ง', 'Meta ไม่พร้อมใช้งานชั่วคราว โปรดลองภายหลัง', 'พยายามมากเกินไป โปรดลองภายหลัง', 'การเชื่อมต่อไม่พร้อมใช้งานในขณะนี้', 'คุณไม่มีสิทธิ์เปลี่ยนการเชื่อมต่อนี้', 'ตรวจสอบช่องนี้ ID ต้องมีตัวเลข 5–32 หลัก และต้องกรอกข้อมูลรับรอง', 'บันทึกการเชื่อมต่อไม่ได้ โปรดลองอีกครั้ง'],
  ja: ['WhatsApp 接続', 'Meta アプリの認証情報で WhatsApp Business アカウントを接続します。', 'コールバック URL', 'コピー', 'コピーしました。', 'テキストを選択して手動でコピーしてください。', 'テスト環境', '本番環境', '接続済み', '未接続', 'エラー', '保存済みアクセストークン', '表示電話番号', '認証済みの名前', '最終確認', '未確認', '検証トークン', 'コールバック URL とこのトークンを Meta アプリの webhook 設定に貼り付けてください。', 'アクセストークン', 'アプリシークレット', '電話番号 ID', 'ビジネスアカウント ID', '接続', '更新', '接続解除', 'この WhatsApp アカウントの接続を解除しますか？再接続には認証情報の再入力が必要です。', 'Meta が認証情報を拒否しました。確認して再試行してください。', 'Meta は一時的に利用できません。後で再試行してください。', '試行回数が多すぎます。後で再試行してください。', '現在、接続機能を利用できません。', 'この接続を変更する権限がありません。', 'この項目を確認してください。ID は 5〜32 桁の数字で、認証情報は必須です。', '接続を保存できませんでした。再試行してください。'],
  ko: ['WhatsApp 연결', 'Meta 앱 인증 정보로 WhatsApp Business 계정을 연결하세요.', '콜백 URL', '복사', '복사했습니다.', '텍스트를 선택하여 직접 복사하세요.', '테스트 환경', '운영 환경', '연결됨', '연결되지 않음', '오류', '저장된 액세스 토큰', '표시 전화번호', '인증된 이름', '마지막 확인', '아직 확인하지 않음', '확인 토큰', '콜백 URL과 이 토큰을 Meta 앱의 webhook 설정에 붙여 넣으세요.', '액세스 토큰', '앱 시크릿', '전화번호 ID', '비즈니스 계정 ID', '연결', '업데이트', '연결 해제', '이 WhatsApp 계정의 연결을 해제할까요? 다시 연결하려면 인증 정보를 다시 입력해야 합니다.', 'Meta가 인증 정보를 거부했습니다. 확인 후 다시 시도하세요.', 'Meta를 일시적으로 사용할 수 없습니다. 나중에 다시 시도하세요.', '시도 횟수가 너무 많습니다. 나중에 다시 시도하세요.', '현재 연결 기능을 사용할 수 없습니다.', '이 연결을 변경할 권한이 없습니다.', '이 필드를 확인하세요. ID는 5–32자리 숫자여야 하며 인증 정보는 필수입니다.', '연결을 저장할 수 없습니다. 다시 시도하세요.'],
};
for (const [locale, values] of Object.entries(copy)) Object.assign(messages[locale], Object.fromEntries(keys.map((key, index) => [key, values[index]])));

export function mountWhatsAppConnection(root, { csrfToken, onUnauthorized, request }) {
  const section = document.createElement('section');
  section.className = 'settings-card integration-status-card whatsapp-connection-card';
  section.hidden = true;
  root.append(section);
  const identity = csrfToken();
  let epoch = 0;
  const current = ticket => section.isConnected && ticket === epoch && csrfToken() === identity;
  const blocks = [];
  function element(tag, key, className) {
    const node = document.createElement(tag);
    if (key) { node.dataset.i18n = key; node.textContent = t(key); }
    if (className) node.className = className;
    return node;
  }
  function statusLine() {
    const line = element('p', null, 'whatsapp-status');
    line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite');
    return line;
  }
  function setStatus(line, key) {
    line.dataset.i18n = key; line.textContent = key ? t(key) : '';
  }
  function copyField(parent, key, value) {
    const label = element('label', null, 'whatsapp-copy-field');
    const row = element('div', null, 'whatsapp-copy-row');
    const input = element('input'); input.readOnly = true; input.value = value || ''; input.autocomplete = 'off';
    const button = element('button', 'waCopy', 'secondary-button'); button.type = 'button'; button.disabled = !input.value;
    button.dataset.i18nAria = key; button.setAttribute('aria-label', t(key) + ': ' + t('waCopy'));
    const line = statusLine();
    button.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard');
        await navigator.clipboard.writeText(input.value);
        setStatus(line, 'waCopied');
      } catch { input.focus(); input.select(); setStatus(line, 'waSelectCopy'); }
    });
    // Keep the button outside the label so clicking it does not focus the input.
    label.append(element('span', key), input); row.append(label, button); parent.append(row, line);
  }
  function mountEnvironment(environment, connection, ticket) {
    const block = element('article', null, 'whatsapp-environment');
    const details = element('div', null, 'whatsapp-details');
    const form = element('form', null, 'whatsapp-form');
    const fields = {};
    for (const [name, key, password] of [['accessToken', 'waAccessToken', true], ['appSecret', 'waAppSecret', true], ['phoneNumberId', 'waPhoneId', false], ['businessAccountId', 'waBusinessId', false]]) {
      const label = element('label'); const input = element('input');
      input.name = name; input.type = password ? 'password' : 'text'; input.autocomplete = 'off'; input.required = true;
      if (!password) { input.inputMode = 'numeric'; input.pattern = '[0-9]{5,32}'; input.minLength = 5; input.maxLength = 32; }
      label.append(element('span', key), input); form.append(label); fields[name] = input;
    }
    const actions = element('div', null, 'whatsapp-actions');
    const submit = element('button', 'waConnect', 'primary-button'); submit.type = 'submit';
    const disconnect = element('button', 'waDisconnect', 'secondary-button'); disconnect.type = 'button';
    const line = statusLine();
    actions.append(submit, disconnect); form.append(actions, line);
    block.append(element('h3', environment === 'SANDBOX' ? 'waSandbox' : 'waProduction'), details, form);
    let state = connection, busy = false;
    function renderDetails(hydrate = false) {
      const connected = state?.status === 'CONNECTED';
      const config = state?.publicConfig || {};
      details.replaceChildren(element('strong', connected ? 'waConnected' : state?.status === 'ERROR' ? 'waError' : 'waNotConnected'));
      const entries = [['waPhone', config.displayPhoneNumber], ['waName', config.verifiedName]];
      if (connected) entries.unshift(['waSecretHint', state.secretHint]);
      let checked = t('waNever');
      if (state?.lastCheckedAt) { try { checked = formatDate(state.lastCheckedAt); } catch { /* Invalid timestamps stay unavailable. */ } }
      entries.push(['waChecked', checked]);
      const list = element('dl');
      for (const [key, value] of entries) {
        const text = element('dd'); text.textContent = value || '—'; list.append(element('dt', key), text);
      }
      details.append(list);
      // The verify token only exists once an account has been connected; before that there is nothing to paste into Meta.
      if (config.verifyToken) { copyField(details, 'waVerifyToken', config.verifyToken); details.append(element('p', 'waWebhookHelp')); }
      submit.dataset.i18n = connected ? 'waUpdate' : 'waConnect'; submit.textContent = t(submit.dataset.i18n);
      disconnect.hidden = !connected;
      if (hydrate) { fields.phoneNumberId.value = config.phoneNumberId || ''; fields.businessAccountId.value = config.businessAccountId || ''; }
    }
    function showError(error) {
      const errors = { CONNECTION_REJECTED: 'waRejected', PROVIDER_UNAVAILABLE: 'waProviderUnavailable', RATE_LIMITED: 'waRateLimited', INTEGRATIONS_UNAVAILABLE: 'waUnavailable', FORBIDDEN: 'waForbidden', INVALID_INPUT: 'waInvalid' };
      const key = errors[error.code] || 'waFailed';
      setStatus(line, key);
      const field = error.code === 'INVALID_INPUT' && Object.hasOwn(fields, error.field) ? fields[error.field] : null;
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    }
    async function mutate(method) {
      if (busy || !current(ticket)) return;
      busy = true; submit.disabled = true; disconnect.disabled = true; setStatus(line, '');
      for (const field of Object.values(fields)) field.removeAttribute('aria-invalid');
      try {
        const body = method === 'PUT' ? {
          accessToken: fields.accessToken.value,
          appSecret: fields.appSecret.value,
          phoneNumberId: fields.phoneNumberId.value,
          businessAccountId: fields.businessAccountId.value,
        } : {};
        const result = await request(method, apiUrl(`v1/seller/integrations/whatsapp/${environment}`), body, csrfToken, () => { if (current(ticket)) onUnauthorized(); });
        fields.accessToken.value = ''; fields.appSecret.value = '';
        if (!current(ticket)) return;
        state = result; renderDetails(true);
      } catch (error) { if (current(ticket) && error.message !== 'unauthorized') showError(error); }
      finally { busy = false; submit.disabled = false; disconnect.disabled = false; }
    }
    form.addEventListener('submit', event => { event.preventDefault(); mutate('PUT'); });
    disconnect.addEventListener('click', async () => {
      if (busy || !current(ticket)) return;
      busy = true; submit.disabled = true; disconnect.disabled = true;
      const accepted = await confirmModal(t('waDisconnectConfirm'), { title: t('waDisconnect'), confirmLabel: t('waDisconnect') });
      busy = false; submit.disabled = false; disconnect.disabled = false;
      if (accepted && current(ticket)) mutate('DELETE');
    });
    renderDetails(true); blocks.push({ renderDetails });
    return block;
  }
  async function load() {
    const ticket = ++epoch;
    try {
      const response = await fetch(apiUrl('v1/seller/integrations/whatsapp'), { cache: 'no-store' });
      if (!current(ticket)) return;
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) return;
      const data = await response.json();
      if (!current(ticket) || data.available !== true) return;
      section.append(element('h2', 'waHeading'), element('p', 'waIntro'));
      copyField(section, 'waCallback', data.webhookUrl);
      const environments = element('div', null, 'whatsapp-environments');
      for (const environment of ['SANDBOX', 'PRODUCTION']) environments.append(mountEnvironment(environment, data.connections?.find(connection => connection.environment === environment), ticket));
      section.append(environments); section.hidden = false;
    } catch { /* Unavailable connections stay hidden. */ }
  }
  load();
  return { refreshLocale() {
    translate(section);
    for (const block of blocks) block.renderDetails();
    for (const button of section.querySelectorAll('[data-i18n-aria]')) button.setAttribute('aria-label', t(button.dataset.i18nAria) + ': ' + t('waCopy'));
  } };
}
