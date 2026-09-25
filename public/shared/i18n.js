export const languages = [
  { code: 'en', label: 'English' },
  { code: 'ms', label: 'Bahasa Melayu' },
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
];

const messages = {
  en: {
    brand: 'Online Shopping', sellerPortal: 'Seller portal', shop: 'Shop', signInTitle: 'Welcome back',
    signInIntro: 'Sign in to manage products and orders.', username: 'Username', password: 'Password',
    signIn: 'Sign in', signOut: 'Sign out', dashboard: 'Dashboard', products: 'Products',
    salesManager: 'Sales Manager', salesOrders: 'Sales Orders', orderReview: 'Sales Order Confirmation',
    profile: 'View profile', account: 'Account', collapse: 'Collapse navigation', expand: 'Expand navigation',
    openMenu: 'Open navigation', closeMenu: 'Close navigation', welcome: 'Welcome',
    authError: 'Sign in failed. Check your details and try again.', networkError: 'Connection failed. Try again.',
    loading: 'Loading…', noProducts: 'No products yet.', notReady: 'This area is being prepared.',
    noOrders: 'No orders yet.', selectLanguage: 'Language', signedOut: 'You have signed out.',
    loginPrompt: 'Seller access only', protected: 'Your catalog and orders are private.',
    offlineTitle: "You're offline", offlineMessage: 'Connect to the internet to continue. Orders and seller decisions cannot be saved offline.', retry: 'Try again',
  },
  ms: {
    brand: 'Online Shopping', sellerPortal: 'Portal penjual', shop: 'Kedai', signInTitle: 'Selamat kembali',
    signInIntro: 'Log masuk untuk mengurus produk dan pesanan.', username: 'Nama pengguna', password: 'Kata laluan',
    signIn: 'Log masuk', signOut: 'Log keluar', dashboard: 'Papan pemuka', products: 'Produk',
    salesManager: 'Pengurusan jualan', salesOrders: 'Pesanan jualan', orderReview: 'Pengesahan pesanan',
    profile: 'Lihat profil', account: 'Akaun', collapse: 'Runtuhkan navigasi', expand: 'Kembangkan navigasi',
    openMenu: 'Buka navigasi', closeMenu: 'Tutup navigasi', welcome: 'Selamat datang',
    authError: 'Log masuk gagal. Semak butiran dan cuba lagi.', networkError: 'Sambungan gagal. Cuba lagi.',
    loading: 'Memuatkan…', noProducts: 'Belum ada produk.', notReady: 'Bahagian ini sedang disediakan.',
    noOrders: 'Belum ada pesanan.', selectLanguage: 'Bahasa', signedOut: 'Anda telah log keluar.',
    loginPrompt: 'Akses penjual sahaja', protected: 'Katalog dan pesanan anda adalah peribadi.',
    offlineTitle: 'Anda di luar talian', offlineMessage: 'Sambung ke internet untuk meneruskan. Pesanan dan keputusan penjual tidak boleh disimpan di luar talian.', retry: 'Cuba lagi',
  },
  'zh-Hans': {
    brand: 'Online Shopping', sellerPortal: '卖家后台', shop: '商店', signInTitle: '欢迎回来',
    signInIntro: '登录后管理商品和订单。', username: '用户名', password: '密码',
    signIn: '登录', signOut: '退出登录', dashboard: '概览', products: '商品',
    salesManager: '销售管理', salesOrders: '销售订单', orderReview: '订单确认',
    profile: '查看资料', account: '账户', collapse: '收起导航', expand: '展开导航',
    openMenu: '打开导航', closeMenu: '关闭导航', welcome: '欢迎',
    authError: '登录失败，请检查信息后重试。', networkError: '连接失败，请重试。',
    loading: '加载中…', noProducts: '暂无商品。', notReady: '此区域正在准备中。',
    noOrders: '暂无订单。', selectLanguage: '语言', signedOut: '你已退出登录。',
    loginPrompt: '仅限卖家访问', protected: '你的商品和订单为私有数据。',
    offlineTitle: '当前离线', offlineMessage: '请连接网络后继续。离线时无法保存订单或卖家决定。', retry: '重试',
  },
  vi: {
    brand: 'Online Shopping', sellerPortal: 'Cổng người bán', shop: 'Cửa hàng', signInTitle: 'Chào mừng trở lại',
    signInIntro: 'Đăng nhập để quản lý sản phẩm và đơn hàng.', username: 'Tên đăng nhập', password: 'Mật khẩu',
    signIn: 'Đăng nhập', signOut: 'Đăng xuất', dashboard: 'Tổng quan', products: 'Sản phẩm',
    salesManager: 'Quản lý bán hàng', salesOrders: 'Đơn hàng', orderReview: 'Xác nhận đơn hàng',
    profile: 'Xem hồ sơ', account: 'Tài khoản', collapse: 'Thu gọn điều hướng', expand: 'Mở rộng điều hướng',
    openMenu: 'Mở điều hướng', closeMenu: 'Đóng điều hướng', welcome: 'Chào mừng',
    authError: 'Đăng nhập thất bại. Kiểm tra thông tin rồi thử lại.', networkError: 'Lỗi kết nối. Thử lại.',
    loading: 'Đang tải…', noProducts: 'Chưa có sản phẩm.', notReady: 'Khu vực này đang được chuẩn bị.',
    noOrders: 'Chưa có đơn hàng.', selectLanguage: 'Ngôn ngữ', signedOut: 'Bạn đã đăng xuất.',
    loginPrompt: 'Chỉ dành cho người bán', protected: 'Sản phẩm và đơn hàng của bạn là riêng tư.',
    offlineTitle: 'Bạn đang ngoại tuyến', offlineMessage: 'Kết nối internet để tiếp tục. Không thể lưu đơn hàng hoặc quyết định của người bán khi ngoại tuyến.', retry: 'Thử lại',
  },
  th: {
    brand: 'Online Shopping', sellerPortal: 'ระบบผู้ขาย', shop: 'ร้านค้า', signInTitle: 'ยินดีต้อนรับกลับ',
    signInIntro: 'เข้าสู่ระบบเพื่อจัดการสินค้าและคำสั่งซื้อ', username: 'ชื่อผู้ใช้', password: 'รหัสผ่าน',
    signIn: 'เข้าสู่ระบบ', signOut: 'ออกจากระบบ', dashboard: 'ภาพรวม', products: 'สินค้า',
    salesManager: 'จัดการยอดขาย', salesOrders: 'คำสั่งซื้อ', orderReview: 'ยืนยันคำสั่งซื้อ',
    profile: 'ดูโปรไฟล์', account: 'บัญชี', collapse: 'ย่อเมนู', expand: 'ขยายเมนู',
    openMenu: 'เปิดเมนู', closeMenu: 'ปิดเมนู', welcome: 'ยินดีต้อนรับ',
    authError: 'เข้าสู่ระบบไม่สำเร็จ ตรวจสอบข้อมูลแล้วลองอีกครั้ง', networkError: 'เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง',
    loading: 'กำลังโหลด…', noProducts: 'ยังไม่มีสินค้า', notReady: 'ส่วนนี้กำลังเตรียมพร้อม',
    noOrders: 'ยังไม่มีคำสั่งซื้อ', selectLanguage: 'ภาษา', signedOut: 'คุณออกจากระบบแล้ว',
    loginPrompt: 'สำหรับผู้ขายเท่านั้น', protected: 'สินค้าและคำสั่งซื้อของคุณเป็นข้อมูลส่วนตัว',
    offlineTitle: 'คุณออฟไลน์อยู่', offlineMessage: 'เชื่อมต่ออินเทอร์เน็ตเพื่อดำเนินการต่อ ไม่สามารถบันทึกคำสั่งซื้อหรือการตัดสินใจของผู้ขายขณะออฟไลน์ได้', retry: 'ลองอีกครั้ง',
  },
  ja: {
    brand: 'Online Shopping', sellerPortal: '販売者ポータル', shop: 'ショップ', signInTitle: 'おかえりなさい',
    signInIntro: 'ログインして商品と注文を管理します。', username: 'ユーザー名', password: 'パスワード',
    signIn: 'ログイン', signOut: 'ログアウト', dashboard: 'ダッシュボード', products: '商品',
    salesManager: '販売管理', salesOrders: '注文一覧', orderReview: '注文確認',
    profile: 'プロフィールを表示', account: 'アカウント', collapse: 'ナビを折りたたむ', expand: 'ナビを広げる',
    openMenu: 'ナビを開く', closeMenu: 'ナビを閉じる', welcome: 'ようこそ',
    authError: 'ログインできませんでした。入力内容を確認してください。', networkError: '接続できません。再試行してください。',
    loading: '読み込み中…', noProducts: '商品はまだありません。', notReady: 'この機能は準備中です。',
    noOrders: '注文はまだありません。', selectLanguage: '言語', signedOut: 'ログアウトしました。',
    loginPrompt: '販売者専用', protected: '商品と注文は非公開です。',
    offlineTitle: 'オフラインです', offlineMessage: '続けるにはインターネットに接続してください。オフラインでは注文や販売者の判断を保存できません。', retry: '再試行',
  },
  ko: {
    brand: 'Online Shopping', sellerPortal: '판매자 포털', shop: '쇼핑몰', signInTitle: '다시 오신 것을 환영합니다',
    signInIntro: '로그인하여 상품과 주문을 관리하세요.', username: '사용자 이름', password: '비밀번호',
    signIn: '로그인', signOut: '로그아웃', dashboard: '대시보드', products: '상품',
    salesManager: '판매 관리', salesOrders: '주문 목록', orderReview: '주문 확인',
    profile: '프로필 보기', account: '계정', collapse: '탐색 메뉴 접기', expand: '탐색 메뉴 펼치기',
    openMenu: '탐색 메뉴 열기', closeMenu: '탐색 메뉴 닫기', welcome: '환영합니다',
    authError: '로그인에 실패했습니다. 정보를 확인하고 다시 시도하세요.', networkError: '연결에 실패했습니다. 다시 시도하세요.',
    loading: '불러오는 중…', noProducts: '아직 상품이 없습니다.', notReady: '이 기능은 준비 중입니다.',
    noOrders: '아직 주문이 없습니다.', selectLanguage: '언어', signedOut: '로그아웃했습니다.',
    loginPrompt: '판매자 전용', protected: '상품과 주문 정보는 비공개입니다.',
    offlineTitle: '오프라인 상태입니다', offlineMessage: '계속하려면 인터넷에 연결하세요. 오프라인에서는 주문이나 판매자 결정을 저장할 수 없습니다.', retry: '다시 시도',
  },
};

let current = 'en';
try {
  const saved = localStorage.getItem('online-shopping-language');
  if (languages.some(({ code }) => code === saved)) current = saved;
} catch { /* Language preference is optional. */ }

export function locale() { return current; }
export function t(key) { return messages[current]?.[key] || messages.en[key] || key; }
export function setLocale(code) {
  if (!languages.some(({ code: supported }) => supported === code)) return;
  current = code;
  document.documentElement.lang = code;
  try { localStorage.setItem('online-shopping-language', code); } catch { /* Optional. */ }
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((node) => { node.setAttribute('aria-label', t(node.dataset.i18nAria)); });
  document.dispatchEvent(new CustomEvent('localechange'));
}

export function setupLanguageSelect(select) {
  for (const { code, label } of languages) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    select.append(option);
  }
  select.value = current;
  select.addEventListener('change', () => setLocale(select.value));
  setLocale(current);
}
