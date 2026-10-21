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
  function mountGuide() {
    const guide = element('details');
    guide.append(element('summary', 'waGuide'));
    for (const key of ['waStep1', 'waStep2', 'waStep3', 'waStep4', 'waLanguages']) guide.append(element('p', key));
    const table = element('table');
    const header = element('tr'); header.append(element('th', 'waTemplateName'), element('th', 'waTemplateBody')); table.append(header);
    for (const [name, body] of [
      ['order_submitted', 'Hello {{1}}, we received your order {{2}}.'],
      ['order_confirmed', 'Hello {{1}}, your order {{2}} is confirmed.'],
      ['order_rejected', 'Hello {{1}}, we cannot accept your order {{2}}.'],
      ['order_shipped', 'Hello {{1}}, your order {{2}} has shipped with {{3}}. Tracking number: {{4}}.'],
    ]) {
      const row = element('tr');
      for (const text of [name, body]) { const cell = element('td'); cell.textContent = text; row.append(cell); }
      table.append(row);
    }
    guide.append(table, element('p', 'waReadinessLimit'));
    return guide;
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
    const readiness = element('button', 'waReadiness', 'secondary-button'); readiness.type = 'button';
    const readinessResult = element('div');
    readinessResult.setAttribute('role', 'status'); readinessResult.setAttribute('aria-live', 'polite');
    readiness.addEventListener('click', async () => {
      if (busy || !current(ticket)) return;
      busy = true; readiness.disabled = true; submit.disabled = true; disconnect.disabled = true;
      try {
        const response = await fetch(apiUrl(`v1/seller/integrations/whatsapp/${environment}/readiness`), { cache: 'no-store' });
        if (!current(ticket)) return;
        if (response.status === 401) { onUnauthorized(); return; }
        if (!response.ok) { showError({ code: response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE' }); return; }
        const result = await response.json();
        if (!current(ticket)) return;
        readinessResult.replaceChildren();
        const checked = element('p'); checked.textContent = formatDate(result.checkedAt); readinessResult.append(checked);
        const labels = { phoneOwnership: 'waPhoneOwnership', appSubscription: 'waAppSubscription', templates: 'waTemplatesCheck', appSecret: 'waAppSecretCheck' };
        for (const check of result.checks) {
          const row = element('p'), badge = element('strong');
          badge.textContent = check.status;
          row.append(badge, element('span', labels[check.id]));
          readinessResult.append(row);
        }
        const table = element('table');
        for (const template of result.templates) {
          const row = element('tr');
          for (const value of [template.name, template.language, template.status]) {
            const cell = element('td'); cell.textContent = value; row.append(cell);
          }
          table.append(row);
        }
        readinessResult.append(table, element('p', 'waUnknownHelp'));
      } catch { if (current(ticket)) showError({ code: 'PROVIDER_UNAVAILABLE' }); }
      finally { busy = false; readiness.disabled = false; submit.disabled = false; disconnect.disabled = false; }
    });
    actions.append(submit, disconnect); form.append(actions, line);
    form.append(readiness, readinessResult);
    block.append(element('h3', environment === 'SANDBOX' ? 'waSandbox' : 'waProduction'), details, form);
    let state = connection, busy = false;
    function renderDetails(hydrate = false) {
      const connected = state?.status === 'CONNECTED';
      readiness.hidden = !connected;
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
        readinessResult.replaceChildren();
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
      section.append(mountGuide());
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
