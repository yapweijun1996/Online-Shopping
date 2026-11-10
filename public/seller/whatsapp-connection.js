import { apiUrl } from '../shared/base-path.js';
import { messages, t, translate, formatDate } from '../shared/i18n.js';
import './whatsapp-cloud-copy.js';
import { cloudProjection, invalidCredentialField } from './whatsapp-cloud-state.js';
import { icon } from '../shared/icons.js';
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

const setupCopy = {
  waGuide: 'How to connect',
  waStep1: '1. Create a Meta developer app (Business type) and add the WhatsApp product.',
  waStep2: '2. Access token: create a System User permanent token with whatsapp_business_messaging and whatsapp_business_management, assigned to your WABA assets. App Secret: App settings → Basic. Phone Number ID and WhatsApp Business Account ID: WhatsApp → API Setup (not your phone digits or Business Portfolio ID). Paste the four fields below and connect.',
  waStep3: '3. Copy the Callback URL and the connected account’s Verify token into Meta webhook settings. Verify the callback, subscribe to messages, and subscribe the app to the WABA. The Verify token is not the App Secret.',
  waStep4: '4. Create these exact templates in Meta, category Utility. Body variables in order: {{1}} buyer name, {{2}} order number; shipped adds {{3}} carrier, {{4}} tracking number. Meta decides approval and category.',
  waLanguages: 'Create each template in the languages offered to buyers: en, ms, zh_CN, vi, th, ja, ko. Other buyer locales fall back to en. Readiness checks all seven supported languages.',
  waTemplateName: 'Template name', waTemplateBody: 'Suggested English body (Utility)',
  waReadiness: 'Check readiness', waReadinessLimit: 'Connected only checks the token and Phone Number ID. Readiness does not prove billing, registration, messaging permission or handset delivery. Test every order message with an opted-in number you control.',
  waPhoneOwnership: 'Phone belongs to WABA. On FAIL, correct the WABA ID / Phone Number ID and token asset permissions.',
  waAppSubscription: 'WABA has a subscribed app. On FAIL, subscribe your Meta app to the WABA. A non-empty list does not prove it is the intended app.',
  waTemplatesCheck: 'Templates. On FAIL, create missing templates or obtain approval for each required language.',
  waAppSecretCheck: 'App Secret is proven by the first signed webhook. If UNKNOWN, send a reply from a controlled handset; verify App Secret and webhook settings.',
  waUnknownHelp: 'UNKNOWN means evidence is unavailable or incomplete. Check connectivity / Meta permissions and try again; never treat UNKNOWN as ready.',
};
const setupTranslations = {
  ms: ['Cara menyambung', '1. Cipta aplikasi pembangun Meta jenis Business dan tambah produk WhatsApp.',
    '2. Access token: token kekal System User dengan whatsapp_business_messaging dan whatsapp_business_management serta akses aset WABA. App Secret: App settings → Basic. Phone Number ID dan WhatsApp Business Account ID: WhatsApp → API Setup, bukan digit telefon atau ID Business Portfolio. Isi empat medan dan sambungkan.',
    '3. Salin Callback URL dan Verify token akaun tersambung ke tetapan webhook Meta. Sahkan, langgan messages dan langgan aplikasi ke WABA. Verify token bukan App Secret.',
    '4. Cipta templat tepat ini sebagai Utility. Turutan pemboleh ubah: {{1}} nama pembeli, {{2}} nombor pesanan; shipped menambah {{3}} kurier, {{4}} nombor penjejakan. Meta menentukan kelulusan dan kategori.',
    'Cipta setiap templat untuk bahasa pembeli: en, ms, zh_CN, vi, th, ja, ko. Bahasa lain menggunakan en. Semakan meliputi ketujuh-tujuh bahasa.',
    'Nama templat', 'Cadangan teks bahasa Inggeris (Utility)', 'Semak kesediaan',
    'Connected hanya menyemak token dan Phone Number ID. Semakan tidak membuktikan bil, pendaftaran, izin mesej atau penghantaran ke telefon. Uji semua mesej dengan nombor milik anda yang bersetuju.',
    'Telefon milik WABA. Jika FAIL, betulkan ID WABA / Phone Number ID dan izin aset token.',
    'WABA mempunyai aplikasi dilanggan. Jika FAIL, langgan aplikasi Meta anda ke WABA. Senarai tidak kosong tidak membuktikan identiti aplikasi yang dimaksudkan.',
    'Templat. Jika FAIL, cipta templat hilang atau dapatkan kelulusan setiap bahasa.',
    'App Secret dibuktikan oleh webhook bertandatangan pertama. Jika UNKNOWN, balas dari telefon ujian; semak App Secret dan tetapan webhook.',
    'UNKNOWN bermaksud bukti tiada atau tidak lengkap. Semak sambungan / izin Meta dan cuba lagi; bukan sedia.'],
  'zh-Hans': ['如何连接', '1. 创建 Business 类型的 Meta 开发者应用，并添加 WhatsApp 产品。',
    '2. Access token：创建具有 whatsapp_business_messaging 和 whatsapp_business_management 权限及 WABA 资产访问权的 System User 永久令牌。App Secret：App settings → Basic。Phone Number ID 和 WhatsApp Business Account ID：WhatsApp → API Setup，不是电话号码或 Business Portfolio ID。填写四项后连接。',
    '3. 将回调网址和已连接账号的 Verify token 复制到 Meta webhook 设置，完成验证，订阅 messages，并将应用订阅到 WABA。Verify token 不是 App Secret。',
    '4. 按准确名称创建 Utility 模板。正文变量依次为 {{1}} 买家姓名、{{2}} 订单号；shipped 增加 {{3}} 承运商、{{4}} 运单号。类别和批准由 Meta 决定。',
    '为买家使用的语言创建每个模板：en、ms、zh_CN、vi、th、ja、ko。其他语言回退到 en。就绪检查覆盖全部七种语言。',
    '模板名称', '建议的英文正文（Utility）', '检查就绪状态',
    '已连接仅检查令牌和 Phone Number ID。就绪检查不证明计费、注册、消息权限或手机送达。请用您控制且已同意接收的号码测试所有订单消息。',
    '号码属于 WABA。FAIL 时请纠正 WABA ID / Phone Number ID 及令牌资产权限。',
    'WABA 有订阅应用。FAIL 时将您的 Meta 应用订阅到 WABA。列表非空不证明是预期应用。',
    '模板。FAIL 时创建缺失模板，或取得每种语言的批准。',
    'App Secret 由首个有效签名 webhook 证明。UNKNOWN 时从测试手机回复，并检查 App Secret 和 webhook 设置。',
    'UNKNOWN 表示证据不可用或不完整。检查网络和 Meta 权限后重试，不能视为就绪。'],
  vi: ['Cách kết nối', '1. Tạo ứng dụng Meta loại Business và thêm sản phẩm WhatsApp.',
    '2. Access token: tạo token vĩnh viễn System User với whatsapp_business_messaging, whatsapp_business_management và quyền tài sản WABA. App Secret: App settings → Basic. Phone Number ID và WhatsApp Business Account ID: WhatsApp → API Setup, không phải số điện thoại hay Business Portfolio ID. Điền bốn trường rồi kết nối.',
    '3. Sao chép Callback URL và Verify token của tài khoản đã kết nối vào webhook Meta. Xác minh, đăng ký messages và đăng ký ứng dụng với WABA. Verify token không phải App Secret.',
    '4. Tạo đúng các mẫu này thuộc Utility. Biến theo thứ tự: {{1}} tên người mua, {{2}} mã đơn; shipped thêm {{3}} hãng vận chuyển, {{4}} mã theo dõi. Meta quyết định phê duyệt và danh mục.',
    'Tạo mỗi mẫu cho các ngôn ngữ: en, ms, zh_CN, vi, th, ja, ko. Ngôn ngữ khác dùng en. Kiểm tra bao gồm cả bảy ngôn ngữ.',
    'Tên mẫu', 'Nội dung tiếng Anh gợi ý (Utility)', 'Kiểm tra mức độ sẵn sàng',
    'Đã kết nối chỉ kiểm tra token và Phone Number ID. Không chứng minh thanh toán, đăng ký, quyền nhắn tin hay giao đến máy. Thử mọi tin đơn hàng với số bạn kiểm soát và đã đồng ý.',
    'Số thuộc WABA. Nếu FAIL, sửa WABA ID / Phone Number ID và quyền tài sản token.',
    'WABA có ứng dụng đăng ký. Nếu FAIL, đăng ký ứng dụng Meta với WABA. Danh sách có mục không chứng minh đúng ứng dụng.',
    'Mẫu. Nếu FAIL, tạo mẫu thiếu hoặc xin phê duyệt từng ngôn ngữ.',
    'App Secret được chứng minh bằng webhook có chữ ký đầu tiên. Nếu UNKNOWN, trả lời từ máy thử; kiểm tra App Secret và webhook.',
    'UNKNOWN là thiếu bằng chứng hoặc chưa đầy đủ. Kiểm tra mạng / quyền Meta rồi thử lại; không coi là sẵn sàng.'],
  th: ['วิธีเชื่อมต่อ', '1. สร้างแอป Meta ประเภท Business และเพิ่มผลิตภัณฑ์ WhatsApp',
    '2. Access token: สร้างโทเค็นถาวร System User พร้อม whatsapp_business_messaging และ whatsapp_business_management และสิทธิ์สินทรัพย์ WABA ส่วน App Secret อยู่ที่ App settings → Basic ส่วน Phone Number ID และ WhatsApp Business Account ID อยู่ที่ WhatsApp → API Setup ไม่ใช่เบอร์โทรหรือ Business Portfolio ID กรอกสี่ช่องแล้วเชื่อมต่อ',
    '3. คัดลอก Callback URL และ Verify token ของบัญชีที่เชื่อมต่อไปยัง webhook ของ Meta ยืนยันและสมัคร messages รวมทั้งสมัครแอปกับ WABA โดย Verify token ไม่ใช่ App Secret',
    '4. สร้างเทมเพลตชื่อตรงตามนี้ในหมวด Utility ตัวแปรตามลำดับ: {{1}} ชื่อผู้ซื้อ {{2}} เลขคำสั่งซื้อ ส่วน shipped เพิ่ม {{3}} บริษัทขนส่ง {{4}} เลขติดตาม Meta เป็นผู้อนุมัติและจัดหมวด',
    'สร้างทุกเทมเพลตสำหรับภาษา en, ms, zh_CN, vi, th, ja, ko ภาษาอื่นใช้ en การตรวจครอบคลุมทั้งเจ็ดภาษา',
    'ชื่อเทมเพลต', 'ข้อความภาษาอังกฤษที่แนะนำ (Utility)', 'ตรวจสอบความพร้อม',
    'เชื่อมต่อแล้วตรวจเพียงโทเค็นและ Phone Number ID ไม่ยืนยันการเรียกเก็บเงิน การลงทะเบียน สิทธิ์ส่งข้อความ หรือการถึงโทรศัพท์ ทดสอบทุกข้อความด้วยเบอร์ของคุณที่ยินยอมแล้ว',
    'เบอร์อยู่ใน WABA หาก FAIL ให้แก้ WABA ID / Phone Number ID และสิทธิ์สินทรัพย์โทเค็น',
    'WABA มีแอปสมัครอยู่ หาก FAIL ให้สมัครแอป Meta กับ WABA รายการไม่ว่างไม่ได้ยืนยันว่าเป็นแอปที่ต้องการ',
    'เทมเพลต หาก FAIL ให้สร้างส่วนที่ขาดหรือขออนุมัติแต่ละภาษา',
    'App Secret ยืนยันด้วย webhook ที่มีลายเซ็นครั้งแรก หาก UNKNOWN ให้ตอบจากโทรศัพท์ทดสอบและตรวจ App Secret กับ webhook',
    'UNKNOWN หมายถึงไม่มีหลักฐานหรือไม่ครบ ตรวจเครือข่าย / สิทธิ์ Meta แล้วลองใหม่ ไม่ถือว่าพร้อม'],
  ja: ['接続方法', '1. Business タイプの Meta 開発者アプリを作成し、WhatsApp 製品を追加します。',
    '2. Access token：whatsapp_business_messaging と whatsapp_business_management、および WABA 資産権限を持つ System User 永続トークンを作成。App Secret：App settings → Basic。Phone Number ID と WhatsApp Business Account ID：WhatsApp → API Setup。電話番号や Business Portfolio ID ではありません。4 項目を入力して接続します。',
    '3. 接続したアカウントの Callback URL と Verify token を Meta webhook 設定へコピー。検証し、messages と WABA へのアプリ購読を設定します。Verify token は App Secret ではありません。',
    '4. この正確な名前で Utility テンプレートを作成。本文の変数順：{{1}} 購入者名、{{2}} 注文番号。shipped は {{3}} 配送業者、{{4}} 追跡番号を追加。分類と承認は Meta が決定します。',
    '購入者向けの各言語で作成：en、ms、zh_CN、vi、th、ja、ko。他の言語は en にフォールバック。準備確認は全7言語を対象にします。',
    'テンプレート名', '英語本文の提案（Utility）', '準備状況を確認',
    '接続済みはトークンと Phone Number ID のみ確認。課金、登録、送信権限、端末への配信は証明しません。同意済みの管理下の番号で全注文メッセージを試してください。',
    '番号が WABA に所属。FAIL なら WABA ID / Phone Number ID とトークン資産権限を修正。',
    'WABA に購読アプリあり。FAIL なら Meta アプリを WABA に購読。空でない一覧だけでは目的のアプリと証明できません。',
    'テンプレート。FAIL なら不足分を作成し、各言語の承認を取得。',
    'App Secret は最初の署名付き webhook で証明。UNKNOWN ならテスト端末から返信し、App Secret と webhook 設定を確認。',
    'UNKNOWN は証拠なし、または不完全。通信 / Meta 権限を確認して再試行。準備完了と扱わないでください。'],
  ko: ['연결 방법', '1. Business 유형의 Meta 개발자 앱을 만들고 WhatsApp 제품을 추가하세요.',
    '2. Access token: whatsapp_business_messaging, whatsapp_business_management 및 WABA 자산 권한이 있는 System User 영구 토큰을 만드세요. App Secret: App settings → Basic. Phone Number ID 및 WhatsApp Business Account ID: WhatsApp → API Setup. 전화번호나 Business Portfolio ID가 아닙니다. 네 항목을 입력하고 연결하세요.',
    '3. 연결된 계정의 Callback URL과 Verify token을 Meta webhook 설정에 복사하세요. 콜백을 확인하고 messages 및 WABA 앱 구독을 설정하세요. Verify token은 App Secret이 아닙니다.',
    '4. 정확한 이름으로 Utility 템플릿을 만드세요. 본문 변수 순서: {{1}} 구매자 이름, {{2}} 주문 번호. shipped는 {{3}} 배송사, {{4}} 추적 번호 추가. Meta가 분류와 승인을 결정합니다.',
    '구매자 언어별로 생성: en, ms, zh_CN, vi, th, ja, ko. 다른 언어는 en 사용. 준비 확인은 7개 언어 모두 검사합니다.',
    '템플릿 이름', '권장 영어 본문 (Utility)', '준비 상태 확인',
    '연결됨은 토큰과 Phone Number ID만 확인합니다. 결제, 등록, 메시지 권한, 휴대폰 도착을 증명하지 않습니다. 동의한 본인 관리 번호로 모든 주문 메시지를 시험하세요.',
    '번호가 WABA에 속함. FAIL이면 WABA ID / Phone Number ID와 토큰 자산 권한을 수정하세요.',
    'WABA에 구독 앱 있음. FAIL이면 Meta 앱을 WABA에 구독하세요. 목록이 비어 있지 않아도 의도한 앱임을 증명하지 않습니다.',
    '템플릿. FAIL이면 누락 템플릿을 만들거나 각 언어 승인을 받으세요.',
    'App Secret은 첫 서명된 webhook으로 증명됩니다. UNKNOWN이면 시험 전화로 답장하고 App Secret 및 webhook 설정을 확인하세요.',
    'UNKNOWN은 증거가 없거나 불완전함을 뜻합니다. 네트워크 / Meta 권한 확인 후 재시도하세요. 준비 완료로 취급하지 마세요.'],
};
Object.assign(messages.en, setupCopy);
for (const [locale, values] of Object.entries(setupTranslations))
  Object.assign(messages[locale], Object.fromEntries(Object.keys(setupCopy).map((key, index) => [key, values[index]])));

export function mountWhatsAppConnection(root, { csrfToken, onUnauthorized, request }) {
  const el = (tag, key, className) => { const node = document.createElement(tag); if (key) { node.dataset.i18n = key; node.textContent = t(key); } if (className) node.className = className; return node; };
  const button = (key, action, className = 'secondary-button') => { const node = el('button', key, className); node.type = 'button'; node.addEventListener('click', action); return node; };
  const privateField = input => { input.dataset.privateDraft = 'true'; input.dataset.privateDraftRevision = '0'; input.autocomplete = 'off'; return input; };
  const summary = key => { const node = el('summary'); node.append(icon('chevronDown')); if (key) node.append(el('span', key)); return node; };
  const status = () => { const node = el('p', null, 'whatsapp-status'); node.hidden = true; node.setAttribute('role', 'status'); return node; };
  const setStatus = (node, key) => { node.dataset.i18n = key; node.textContent = key ? t(key) : ''; node.hidden = !key; };
  const section = el('section', null, 'settings-card whatsapp-connection-card wa-cloud'); root.append(section);
  const identity = csrfToken(), confirmations = new AbortController();
  let disposed = false, sequence = 0, busy = false, availability = 'loading', selected = 'PRODUCTION', revision = 0, callback = '', pendingBody = null;
  const invalidateCopies = () => { for (const env of environments.values()) for (const field of [env.callback, env.verify]) { field.sequence++; field.job.value = ''; field.pending = false; } };
  const current = ticket => !disposed && section.isConnected && csrfToken() === identity && (ticket === undefined || ticket === sequence);
  const changed = () => document.dispatchEvent(new Event('updateguardchange'));
  const heading = el('h2', 'waCloud_title'), intro = el('p', 'waIntro'), feedback = status();
  const retry = button('retry', () => load()); retry.classList.add('wa-cloud-retry');
  const environmentBar = el('div', null, 'wa-cloud-environments'); environmentBar.setAttribute('role', 'group');
  const overview = el('div', null, 'wa-cloud-overview'), next = el('div', null, 'wa-cloud-next');
  const nav = el('nav', null, 'wa-cloud-nav');
  section.append(heading, intro, feedback, retry, environmentBar, overview, next, nav);
  const environments = new Map(), envButtons = new Map();
  const hasDraft = env => Boolean(env.fields.accessToken.value || env.fields.appSecret.value || ['phoneNumberId', 'businessAccountId'].some(field => env.fields[field].value !== (env.connection?.publicConfig?.[field] || '')));
  const stepKeys = ['waCloud_meta', 'waCloud_credentials', 'waCloud_webhook', 'waCloud_templates'];
  const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? formatDate(value) : t('waNever');
  const evidenceKey = value => value === 'PASS' ? 'waCloud_pass' : value === 'FAIL' ? 'waCloud_fail' : 'waCloud_unknown';
  function clearSensitive() {
    if (pendingBody) { delete pendingBody.accessToken; delete pendingBody.appSecret; pendingBody = null; }
    for (const env of environments.values()) {
      env.fields.accessToken.value = ''; env.fields.appSecret.value = ''; env.fields.accessToken.type = 'password'; env.fields.appSecret.type = 'password'; env.verify.input.value = ''; env.verify.job.value = ''; env.callback.job.value = ''; env.verify.sequence++; env.callback.sequence++; env.verify.pending = false; env.callback.pending = false; env.dirty = false;
      if (env.connection?.publicConfig) env.connection = { ...env.connection, publicConfig: { ...env.connection.publicConfig, verifyToken: '' } };
    }
    revision++; changed();
  }
  function copyField(parent, key, sensitive = false) {
    const row = el('div', null, 'whatsapp-copy-row'), label = el('label', null, 'whatsapp-copy-field'), input = el('input'); input.readOnly = true; input.autocomplete = 'off'; if (sensitive) { privateField(input); input.type = 'password'; }
    label.append(el('span', key), input); const line = status();
    const state = { input, line, sequence: 0, pending: false, job: { value: '' } };
    const copy = button('waCopy', async () => {
      if (!current() || busy || !input.value || state.pending || copy.disabled) return;
      const ticket = sequence, copyTicket = ++state.sequence, snapshot = { value: input.value }; state.job = snapshot; state.pending = true; copy.disabled = true;
      try {
        if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('clipboard');
        await navigator.clipboard.writeText(snapshot.value);
        if (current(ticket) && copyTicket === state.sequence) setStatus(line, 'waCopied');
      } catch {
        if (current(ticket) && copyTicket === state.sequence) { if (sensitive) input.type = 'text'; input.focus(); input.select(); setStatus(line, 'waSelectCopy'); }
      } finally { snapshot.value = ''; if (current(ticket) && copyTicket === state.sequence && state.job === snapshot) { state.pending = false; render(); } }
    });
    copy.replaceChildren(icon('copy')); copy.removeAttribute('data-i18n'); copy.dataset.copyLabel = key;
    row.append(label, copy);
    if (sensitive) { const reveal = button('waCloud_show', () => { input.type = input.type === 'password' ? 'text' : 'password'; render(); }); reveal.dataset.revealField = key; state.reveal = reveal; row.append(reveal); }
    state.copy = copy; parent.append(row, line); return state;
  }
  function step(env, index) {
    const card = el('details', null, 'wa-cloud-step'); card.dataset.step = String(index + 1); card.id = `wa-cloud-${env.name.toLowerCase()}-${index + 1}`;
    const stepSummary = summary(), title = el('span', stepKeys[index]), marker = el('span', null, 'wa-cloud-step-status'); stepSummary.append(title, marker); card.append(stepSummary); env.container.append(card);
    const control = button(stepKeys[index], () => { card.open = true; env.activeStep = index + 1; render(); stepSummary.focus({ preventScroll: true }); card.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }); control.dataset.stepTarget = String(index + 1); control.setAttribute('aria-controls', card.id);
    card.addEventListener('toggle', () => { if (card.open && env.activeStep !== index + 1 && current()) { env.activeStep = index + 1; render(); } });
    env.steps.push({ card, summary: stepSummary, title, marker, control }); return card;
  }
  for (const name of ['PRODUCTION', 'SANDBOX']) {
    const envButton = button(name === 'PRODUCTION' ? 'waProduction' : 'waSandbox', () => { if (busy || !current()) return; selected = name; render(); }); envButton.dataset.environment = name; environmentBar.append(envButton); envButtons.set(name, envButton);
    const env = { name, connection: null, readiness: null, dirty: false, activeStep: 2, fields: {}, steps: [], initialized: false };
    env.container = el('div', null, 'wa-cloud-environment'); env.container.dataset.environment = name; section.append(env.container); environments.set(name, env);
    const meta = step(env, 0); meta.append(el('p', 'waCloud_metaHelp')); const link = el('a', 'waCloud_openMeta', 'secondary-button'); link.href = 'https://developers.facebook.com/apps/'; link.target = '_blank'; link.rel = 'noopener noreferrer'; meta.append(link);
    const credentials = step(env, 1), form = el('form', null, 'whatsapp-form'); form.noValidate = true; env.form = form;
    for (const [field, key, min, max, sensitive] of [['accessToken', 'waAccessToken', 20, 512, true], ['appSecret', 'waAppSecret', 16, 128, true], ['phoneNumberId', 'waPhoneId', 5, 32, false], ['businessAccountId', 'waBusinessId', 5, 32, false]]) {
      const label = el('label'), input = el('input'); input.name = field; input.id = `wa-${name.toLowerCase()}-${field}`; input.type = sensitive ? 'password' : 'text'; input.required = true; input.minLength = min; input.maxLength = max; input.autocomplete = 'off'; input.spellcheck = false;
      if (sensitive) privateField(input); else { input.inputMode = 'numeric'; input.pattern = '[0-9]{5,32}'; }
      const text = el('span', key); const identifier = el('code'); identifier.dataset.credentialIdentifier = key; identifier.textContent = { accessToken: 'Access token', appSecret: 'App Secret', phoneNumberId: 'Phone Number ID', businessAccountId: 'WhatsApp Business Account ID' }[field];
      const row = el('div', null, 'wa-cloud-input-row'); const rule = el('small'); rule.dataset.credentialRule = field; rule.id = `${input.id}-rule`; rule.textContent = sensitive ? `${min}–${max} · ${t('waCloud_noWhitespace')}` : `5–32 · ${t('waCloud_digits')}`; label.append(text, identifier, input); row.append(label); const group = el('div', null, 'wa-cloud-field'); group.append(row, rule);
      if (sensitive) { const reveal = button('waCloud_show', () => { input.type = input.type === 'password' ? 'text' : 'password'; render(); }); reveal.dataset.credentialReveal = field; row.append(reveal); }
      form.append(group); env.fields[field] = input;
      input.addEventListener('input', () => { env.invalidField = null; env.dirty = hasDraft(env); revision++; for (const value of Object.values(env.fields)) value.dataset.privateDraftRevision = String(revision); input.removeAttribute('aria-invalid'); setStatus(env.line, ''); changed(); });
    }
    const help = el('details', null, 'wa-cloud-help'); help.append(summary('waCloud_fieldHelp'), el('p', 'waCloud_tokenHelp'), el('p', 'waCloud_idsHelp'));
    env.secretHint = el('p', null, 'wa-cloud-hint'); env.line = status(); env.line.id = `wa-${name.toLowerCase()}-feedback`; env.line.tabIndex = -1;
    for (const input of Object.values(env.fields)) input.setAttribute('aria-describedby', `${input.id}-rule ${env.line.id}`);
    const actions = el('div', null, 'whatsapp-actions'); env.save = el('button', 'waConnect', 'primary-button'); env.save.type = 'submit';
    env.disconnect = button('waDisconnect', async () => {
      if (busy || !current()) return; busy = true; changed(); render();
      const ticket = sequence;
      const accepted = await confirmModal(t('waCloud_disconnectEnv').replace('{environment}', t(name === 'PRODUCTION' ? 'waProduction' : 'waSandbox')), { title: t('waDisconnect'), confirmLabel: t('waDisconnect'), signal: confirmations.signal });
      if (!current(ticket)) return; busy = false;
      if (accepted) await mutate(env, 'DELETE'); else { render(); changed(); }
    }); actions.append(env.save, env.disconnect); form.append(el('p', 'waCloud_allFields'), env.secretHint, help, actions, env.line); credentials.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); mutate(env, 'PUT'); });
    const webhook = step(env, 2); env.prerequisite = el('div'); env.prerequisite.append(el('p', 'waCloud_prerequisite'), button('waCloud_credentials', () => env.steps[1].control.click()));
    env.webhook = el('div'); env.callback = copyField(env.webhook, 'waCallback'); env.verify = copyField(env.webhook, 'waVerifyToken', true);
    env.webhook.append(el('p', 'waCloud_webhookAction'), el('p', 'waCloud_subscribeAction'), el('p', 'waCloud_noHandshake'));
    env.checkLine = status();
    env.check = button('waReadiness', () => checkReadiness(env)); env.checks = el('div', null, 'wa-cloud-checks'); webhook.append(env.prerequisite, env.webhook, env.check, env.checkLine, env.checks, el('p', 'waUnknownHelp'));
    const templates = step(env, 3); env.counts = el('div', null, 'wa-cloud-counts'); env.matrix = el('details', null, 'wa-cloud-help'); env.matrix.append(summary('waCloud_matrix')); env.records = el('div', null, 'wa-cloud-records'); env.matrix.append(env.records);
    const reference = el('details', null, 'wa-cloud-help'); reference.append(summary('waCloud_reference'), el('p', 'waStep4'), el('p', 'waLanguages'));
    for (const [template, body] of [['order_submitted', 'Hello {{1}}, we received your order {{2}}.'], ['order_confirmed', 'Hello {{1}}, your order {{2}} is confirmed.'], ['order_rejected', 'Hello {{1}}, we cannot accept your order {{2}}.'], ['order_shipped', 'Hello {{1}}, your order {{2}} has shipped with {{3}}. Tracking number: {{4}}.']]) { const row = el('p'), code = el('code'); code.textContent = template; row.append(code, document.createTextNode(`: ${body}`)); reference.append(row); }
    env.templateCheck = button('waReadiness', () => checkReadiness(env)); env.templateLine = status();
    templates.append(env.templateCheck, env.templateLine, env.counts, env.matrix, reference, el('p', 'waReadinessLimit'));
  }
  function render() {
    if (!current()) return;
    translate(section); retry.hidden = availability === 'ready' || busy; environmentBar.hidden = availability === 'loading';
    environmentBar.setAttribute('aria-label', `${t('waProduction')} / ${t('waSandbox')}`);
    section.setAttribute('aria-busy', String(busy));
    nav.replaceChildren(); overview.replaceChildren(); next.replaceChildren();
    for (const env of environments.values()) {
      const chosen = env.name === selected, state = cloudProjection(env.connection, env.readiness, availability); env.container.hidden = !chosen || availability === 'loading';
      envButtons.get(env.name).setAttribute('aria-pressed', String(chosen)); envButtons.get(env.name).disabled = busy;
      for (const input of Object.values(env.fields)) input.disabled = busy || availability !== 'ready';
      const statuses = ['waCloud_external', state.connected ? 'waConnected' : state.connectionStatus === 'DISCONNECTED' ? 'waNotConnected' : 'waCloud_unknown', evidenceKey(state.webhookStatus), evidenceKey(state.templateStatus)];
      env.steps.forEach((entry, index) => { entry.title.textContent = `${index + 1}. ${t(stepKeys[index])}`; entry.marker.textContent = t(statuses[index]); entry.marker.dataset.state = index === 2 ? state.webhookStatus : index === 3 ? state.templateStatus : ''; entry.control.textContent = `${index + 1}. ${t(stepKeys[index])}`; entry.control.setAttribute('aria-current', env.activeStep === index + 1 ? 'step' : 'false'); if (chosen) nav.append(entry.control); });
      env.save.textContent = t(state.connected ? 'waUpdate' : 'waConnect'); env.save.disabled = busy || availability !== 'ready'; env.disconnect.hidden = !state.connected; env.disconnect.disabled = busy || availability !== 'ready';
      env.secretHint.hidden = !env.connection?.secretHint; env.secretHint.textContent = env.connection?.secretHint ? `${t('waSecretHint')}: ${env.connection.secretHint}` : '';
      for (const identifier of env.form.querySelectorAll('[data-credential-identifier]')) identifier.hidden = t(identifier.dataset.credentialIdentifier).toLowerCase() === identifier.textContent.toLowerCase();
      for (const rule of env.form.querySelectorAll('[data-credential-rule]')) { const field = env.fields[rule.dataset.credentialRule]; rule.textContent = `${field.minLength}–${field.maxLength} · ${t(['accessToken', 'appSecret'].includes(field.name) ? 'waCloud_noWhitespace' : 'waCloud_digits')}`; }
      for (const reveal of env.form.querySelectorAll('[data-credential-reveal]')) { const field = env.fields[reveal.dataset.credentialReveal]; const key = field.type === 'password' ? 'waCloud_show' : 'waCloud_hide'; reveal.textContent = t(key); reveal.setAttribute('aria-label', `${t(key)}: ${t(field.name === 'accessToken' ? 'waAccessToken' : 'waAppSecret')}`); reveal.disabled = busy || availability !== 'ready'; }
      const config = env.connection?.publicConfig || {}, hasWebhook = state.connected && typeof config.verifyToken === 'string' && Boolean(config.verifyToken);
      env.webhook.hidden = !hasWebhook; env.prerequisite.hidden = hasWebhook; env.check.disabled = busy || availability !== 'ready' || !state.connected; env.templateCheck.disabled = env.check.disabled;
      for (const [field, value] of [[env.callback, callback], [env.verify, hasWebhook ? config.verifyToken : '']]) {
        if (field.input.value !== value) { if (field === env.verify) field.input.type = 'password'; field.sequence++; field.job.value = ''; field.pending = false; field.input.value = value; revision++; field.input.dataset.privateDraftRevision = String(revision); setStatus(field.line, ''); }
        field.copy.disabled = field.pending || busy || availability !== 'ready' || !value; field.copy.setAttribute('aria-label', `${t(field.copy.dataset.copyLabel)}: ${t('waCopy')}`);
        if (field.reveal) { const key = field.input.type === 'password' ? 'waCloud_show' : 'waCloud_hide'; field.reveal.textContent = t(key); field.reveal.setAttribute('aria-label', `${t(key)}: ${t('waVerifyToken')}`); field.reveal.disabled = busy || !value; }
      }
      env.checks.replaceChildren();
      for (const id of ['phoneOwnership', 'appSubscription', 'appSecret']) { const row = el('div', null, 'wa-cloud-check'), badge = el('strong', evidenceKey(state.checks[id])); badge.dataset.state = state.checks[id]; row.dataset.check = id; row.append(badge, el('span', { phoneOwnership: 'waPhoneOwnership', appSubscription: 'waAppSubscription', appSecret: 'waAppSecretCheck' }[id])); env.checks.append(row); }
      env.counts.replaceChildren();
      for (const [statusName, key] of [['APPROVED', 'approved'], ['PENDING', 'pending'], ['REJECTED', 'rejected'], ['MISSING', 'missing'], ['UNKNOWN', 'unknown']]) { const count = el('span'); count.textContent = `${t(`waCloud_${key}`)}: ${state.counts[statusName]}`; env.counts.append(count); }
      if (!state.templates.length) env.counts.append(el('p', env.readiness ? 'waCloud_unknown' : 'waCloud_notChecked'));
      env.records.replaceChildren();
      for (const record of state.templates) { const row = el('div'), name = el('code'), language = el('code'), badge = el('span'); name.textContent = record.name || t('waCloud_unknown'); language.textContent = record.language || t('waCloud_unknown'); badge.textContent = t(`waCloud_${{ APPROVED: 'approved', PENDING: 'pending', REJECTED: 'rejected', MISSING: 'missing', UNKNOWN: 'unknown' }[record.status]}`); row.append(name, language, badge); env.records.append(row); }
      if (chosen) {
        nav.setAttribute('aria-label', t('waGuide'));
        const label = t(env.name === 'PRODUCTION' ? 'waProduction' : 'waSandbox');
        const badge = el('strong'); badge.textContent = `${label} · ${t(state.connected ? 'waConnected' : state.connectionStatus === 'DISCONNECTED' ? 'waNotConnected' : state.connectionStatus === 'ERROR' ? 'waError' : 'waCloud_unknown')}`;
        const connectionTime = el('p'); connectionTime.textContent = `${t('waChecked')}: ${stamp(env.connection?.lastCheckedAt)}`;
        const readinessTime = el('p'); readinessTime.textContent = `${t('waCloud_checkTime')}: ${state.checkedAt ? stamp(state.checkedAt) : t('waCloud_notChecked')}`;
        overview.append(badge, connectionTime, readinessTime);
        const action = button('waCloud_next', () => env.steps[state.nextStep - 1].control.click()); action.textContent = `${t('waCloud_next')}: ${t(stepKeys[state.nextStep - 1])}`; if (availability === 'ready') next.append(action); else { const explanation = el('p', availability === 'loading' ? 'loading' : availability === 'forbidden' ? 'waForbidden' : availability === 'unavailable' ? 'waUnavailable' : 'waProviderUnavailable'); next.append(explanation); }
      }
    }
  }
  function showError(env, error) {
    const key = { CONNECTION_REJECTED: 'waRejected', PROVIDER_UNAVAILABLE: 'waProviderUnavailable', RATE_LIMITED: 'waRateLimited', INTEGRATIONS_UNAVAILABLE: 'waUnavailable', FORBIDDEN: 'waForbidden', INVALID_INPUT: 'waInvalid' }[error.code] || 'waFailed';
    setStatus(env.line, key); setStatus(env.checkLine, key); setStatus(env.templateLine, key);
    if (error.code === 'FORBIDDEN') { availability = 'forbidden'; clearSensitive(); setStatus(feedback, 'waForbidden'); }
    if (error.code === 'INVALID_INPUT' && Object.hasOwn(env.fields, error.field)) { env.fields[error.field].setAttribute('aria-invalid', 'true'); env.invalidField = error.field; env.fields[error.field].focus(); }
  }
  async function mutate(env, method) {
    if (!current() || busy || availability !== 'ready') return;
    env.invalidField = null;
    const body = method === 'PUT' ? Object.fromEntries(Object.entries(env.fields).map(([key, input]) => [key, input.value])) : {};
    const field = method === 'PUT' ? invalidCredentialField(body) : null;
    if (field) { showError(env, { code: 'INVALID_INPUT', field }); delete body.accessToken; delete body.appSecret; return; }
    const ticket = ++sequence; invalidateCopies(); pendingBody = body; busy = true; env.readiness = null; setStatus(env.line, ''); changed(); render();
    try {
      const result = await request(method, apiUrl(`v1/seller/integrations/whatsapp/${env.name}`), body, csrfToken, () => { if (current(ticket)) { clearSensitive(); onUnauthorized(); } });
      delete body.accessToken; delete body.appSecret;
      if (!current(ticket)) return;
      env.connection = result; env.readiness = null; env.fields.accessToken.value = ''; env.fields.appSecret.value = ''; env.fields.accessToken.type = 'password'; env.fields.appSecret.type = 'password'; env.dirty = false; revision++;
      for (const field of ['phoneNumberId', 'businessAccountId']) env.fields[field].value = result?.publicConfig?.[field] || '';
      env.activeStep = method === 'PUT' && result?.publicConfig?.verifyToken ? 3 : 2; env.steps[env.activeStep - 1].card.open = true;
      setStatus(env.line, method === 'PUT' ? 'waCloud_saved' : 'waCloud_disconnected'); setStatus(env.checkLine, method === 'PUT' ? 'waCloud_saved' : 'waCloud_disconnected');
    } catch (error) { if (current(ticket) && error.message !== 'unauthorized') showError(env, error); }
    finally { delete body.accessToken; delete body.appSecret; if (pendingBody === body) pendingBody = null; if (current(ticket)) { busy = false; render(); if (env.invalidField) { env.fields[env.invalidField].focus(); env.invalidField = null; } else if (env.connection?.status === 'CONNECTED' && !env.dirty) env.steps[2].summary.focus(); changed(); } }
  }
  async function checkReadiness(env) {
    if (!current() || busy || availability !== 'ready' || env.connection?.status !== 'CONNECTED') return;
    const ticket = ++sequence; invalidateCopies(); busy = true; env.readiness = null; setStatus(env.line, ''); setStatus(env.checkLine, ''); setStatus(env.templateLine, ''); render(); changed();
    try {
      const response = await fetch(apiUrl(`v1/seller/integrations/whatsapp/${env.name}/readiness`), { cache: 'no-store' });
      if (!current(ticket)) return;
      if (response.status === 401) { clearSensitive(); onUnauthorized(); return; }
      if (!response.ok) { showError(env, { code: response.status === 403 ? 'FORBIDDEN' : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE' }); return; }
      const result = await response.json(); if (current(ticket)) env.readiness = result;
    } catch { if (current(ticket)) showError(env, { code: 'PROVIDER_UNAVAILABLE' }); }
    finally { if (current(ticket)) { busy = false; render(); changed(); } }
  }
  async function load() {
    if (!current() || busy) return;
    const ticket = ++sequence; invalidateCopies(); busy = true; setStatus(feedback, 'loading'); render();
    try {
      const response = await fetch(apiUrl('v1/seller/integrations/whatsapp'), { cache: 'no-store' });
      if (!current(ticket)) return;
      if (response.status === 401) { clearSensitive(); onUnauthorized(); return; }
      if (!response.ok) { availability = response.status === 403 ? 'forbidden' : 'error'; if (response.status === 403) clearSensitive(); setStatus(feedback, response.status === 403 ? 'waForbidden' : 'waProviderUnavailable'); return; }
      const data = await response.json(); if (!current(ticket)) return;
      if (data?.available !== true) { availability = 'unavailable'; clearSensitive(); setStatus(feedback, 'waUnavailable'); return; }
      if (!Array.isArray(data.connections)) throw new Error('invalid response');
      availability = 'ready'; callback = typeof data.webhookUrl === 'string' ? data.webhookUrl : ''; setStatus(feedback, '');
      for (const env of environments.values()) {
        env.connection = data.connections.find(connection => connection?.environment === env.name) || null; env.readiness = null;
        if (!env.dirty) for (const field of ['phoneNumberId', 'businessAccountId']) env.fields[field].value = env.connection?.publicConfig?.[field] || '';
        if (!env.initialized) { env.activeStep = env.connection?.status === 'CONNECTED' ? 3 : 2; env.steps[env.activeStep - 1].card.open = true; env.initialized = true; }
      }
    } catch { if (current(ticket)) { availability = 'error'; setStatus(feedback, 'waProviderUnavailable'); } }
    finally { if (current(ticket)) { busy = false; render(); changed(); } }
  }
  render(); load();
  return {
    refreshLocale: render,
    hasUnsavedChanges: () => [...environments.values()].some(hasDraft),
    isBusy: () => busy,
    draftSignature: () => `whatsapp-cloud:${revision}`,
    dispose() { disposed = true; sequence++; confirmations.abort(); clearSensitive(); section.remove(); },
  };
}
