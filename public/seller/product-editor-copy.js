import { messages, t } from '../shared/i18n.js';
const locales = ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko'];
const rows = [
["imageDecode", "This image cannot be displayed, or is too large in pixels. Choose a valid image up to 32,768 pixels per side and 40 million pixels in total.", "Gambar tidak dapat dipaparkan atau terlalu besar. Pilih gambar sah sehingga 32,768 piksel setiap sisi dan 40 juta piksel keseluruhan.", "此图片无法显示或像素过大。请选择每边不超过 32,768 像素、总像素不超过 4,000 万的有效图片。", "Không hiển thị được ảnh hoặc ảnh quá lớn. Chọn ảnh hợp lệ tối đa 32.768 pixel mỗi cạnh và tổng 40 triệu pixel.", "ภาพแสดงไม่ได้หรือมีพิกเซลมากเกินไป เลือกภาพที่ถูกต้องไม่เกิน 32,768 พิกเซลต่อด้านและรวม 40 ล้านพิกเซล", "この画像は表示できないか、画素数が大きすぎます。各辺32,768ピクセル以下、合計4,000万画素以下の有効な画像を選んでください。", "이 이미지를 표시할 수 없거나 픽셀이 너무 큽니다. 각 변 최대 32,768픽셀, 총 4천만 픽셀 이하의 올바른 이미지를 선택하세요."],
["assistantInfo", "Connected assistant editing", "Suntingan pembantu tersambung", "已连接助手的编辑支持", "Chỉnh sửa qua trợ lý", "การแก้ไขด้วยผู้ช่วย", "接続したアシスタントでの編集", "연결된 어시스턴트 편집"],
["summary", "Short summary", "Ringkasan", "商品简介", "Tóm tắt", "สรุปสินค้า", "商品の概要", "상품 요약"],
["summaryHelp", "Plain text, up to 2,000 characters. Add long text and images in Rich detail.", "Teks biasa sehingga 2,000 aksara. Tambah teks panjang dan gambar dalam Butiran lengkap.", "纯文字，最多 2,000 字。长篇内容与图片请放在图文详情。", "Văn bản thuần, tối đa 2.000 ký tự. Thêm chữ dài và ảnh trong Nội dung chi tiết.", "ข้อความธรรมดาสูงสุด 2,000 ตัวอักษร เพิ่มข้อความยาวและภาพในรายละเอียด", "プレーンテキストで最大2,000文字。長い文章と画像は詳細コンテンツに追加します。", "일반 텍스트 최대 2,000자. 긴 글과 이미지는 상세 콘텐츠에 추가하세요."],
["protected", "Listings with rich detail are edited in Seller Studio. Protected MCP catalog changes remain unavailable until their review covers detail content.", "Produk dengan butiran diedit dalam Seller Studio. Perubahan katalog MCP terlindung belum tersedia sehingga semakan meliputi butiran.", "包含图文详情的商品请在卖家工作室编辑。受保护的 MCP 商品修改须等待审核支持详情内容后才可使用。", "Sản phẩm có chi tiết được sửa trong Seller Studio. Thay đổi danh mục MCP bảo vệ chưa dùng được cho đến khi xem xét hỗ trợ nội dung này.", "แก้ไขสินค้าที่มีรายละเอียดใน Seller Studio การเปลี่ยนแปลงแค็ตตาล็อก MCP ที่ป้องกันไว้ยังไม่เปิดจนกว่าการตรวจสอบจะครอบคลุมรายละเอียด", "詳細のある商品はSeller Studioで編集します。保護されたMCPカタログ変更は、詳細内容のレビューに対応するまで利用できません。", "상세 내용이 있는 상품은 Seller Studio에서 편집하세요. 보호된 MCP 카탈로그 변경은 검토가 상세 내용을 지원할 때까지 사용할 수 없습니다."],
  [
    "basic",
    "Basic information",
    "Maklumat asas",
    "基本信息",
    "Thông tin cơ bản",
    "ข้อมูลพื้นฐาน",
    "基本情報",
    "기본 정보"
  ],
  [
    "images",
    "Product images",
    "Gambar produk",
    "商品图片",
    "Ảnh sản phẩm",
    "รูปสินค้า",
    "商品画像",
    "상품 이미지"
  ],
  [
    "detail",
    "Rich detail",
    "Butiran lengkap",
    "图文详情",
    "Nội dung chi tiết",
    "รายละเอียด",
    "詳細コンテンツ",
    "상세 콘텐츠"
  ],
  [
    "variants",
    "Variants",
    "Varian",
    "款式规格",
    "Biến thể",
    "ตัวเลือกสินค้า",
    "バリエーション",
    "옵션"
  ],
  [
    "tabs",
    "Product editor sections",
    "Bahagian editor produk",
    "商品编辑分区",
    "Các phần chỉnh sửa",
    "ส่วนแก้ไขสินค้า",
    "商品編集の項目",
    "상품 편집 섹션"
  ],
  [
    "new",
    "New product",
    "Produk baharu",
    "新商品",
    "Sản phẩm mới",
    "สินค้าใหม่",
    "新しい商品",
    "새 상품"
  ],
  [
    "shared",
    "Title, summary, gallery and rich detail are shared by all variants.",
    "Nama, ringkasan, galeri dan butiran dikongsi semua varian.",
    "名称、简介、图库和图文详情由所有款式共用。",
    "Tên, tóm tắt, thư viện và chi tiết dùng chung cho mọi biến thể.",
    "ชื่อ สรุป แกลเลอรีและรายละเอียดใช้ร่วมกันทุกตัวเลือก",
    "名前・概要・ギャラリー・詳細は全バリエーションで共有します。",
    "이름, 요약, 갤러리와 상세 내용은 모든 옵션이 공유합니다."
  ],
  [
    "ai",
    "AI product images",
    "Gambar produk AI",
    "AI 商品图片",
    "Ảnh sản phẩm AI",
    "ภาพสินค้า AI",
    "AI商品画像",
    "AI 상품 이미지"
  ],
  [
    "aiHelp",
    "Open AI Studio with this product selected. A saved main image is required; every variant must be inactive. Generation saves to the shared gallery and uses 2 AI calls per style.",
    "Buka AI Studio dengan produk ini. Perlu gambar utama tersimpan; semua varian mesti tidak aktif. Hasil disimpan ke galeri bersama, 2 panggilan AI setiap gaya.",
    "打开 AI 工作室并选中此商品。需要已保存的主图，所有款式须为未上架。生成结果保存到共用图库，每种风格使用 2 次 AI 调用。",
    "Mở AI Studio với sản phẩm này. Cần ảnh chính đã lưu; tất cả biến thể phải ngừng bán. Ảnh được lưu vào thư viện chung, 2 lượt AI mỗi kiểu.",
    "เปิด AI Studio พร้อมสินค้านี้ ต้องมีภาพหลักที่บันทึกแล้วและปิดขายทุกตัวเลือก ภาพจะบันทึกในแกลเลอรีร่วม ใช้ AI 2 ครั้งต่อสไตล์",
    "この商品を選択してAI Studioを開きます。保存済みのメイン画像が必要で、全バリエーションが非公開である必要があります。生成画像は共有ギャラリーに保存され、1スタイルにつきAIを2回使います。",
    "이 상품을 선택한 AI Studio를 엽니다. 저장된 대표 이미지가 필요하며 모든 옵션이 비활성이어야 합니다. 생성 이미지는 공유 갤러리에 저장되고 스타일당 AI 2회를 사용합니다."
  ],
  [
    "aiHolder",
    "Open the main variant to generate shared gallery images.",
    "Buka varian utama untuk jana gambar galeri bersama.",
    "请打开主款式生成共用图库图片。",
    "Mở biến thể chính để tạo ảnh thư viện chung.",
    "เปิดตัวเลือกหลักเพื่อสร้างภาพแกลเลอรีร่วม",
    "共有ギャラリーの画像はメインバリエーションで生成します。",
    "공유 갤러리 이미지를 생성하려면 대표 옵션을 여세요."
  ],
  [
    "saveFirst",
    "Save the product first to add detail images and use AI Studio.",
    "Simpan produk dahulu untuk tambah gambar butiran dan guna AI Studio.",
    "请先保存商品，再添加详情图片或使用 AI 工作室。",
    "Lưu sản phẩm trước để thêm ảnh chi tiết và dùng AI Studio.",
    "บันทึกสินค้าก่อนเพิ่มภาพรายละเอียดและใช้ AI Studio",
    "先に商品を保存すると詳細画像の追加とAI Studioを利用できます。",
    "상세 이미지를 추가하고 AI Studio를 사용하려면 상품을 먼저 저장하세요."
  ],
  [
    "detailHelp",
    "Build a scrolling detail page with text and images. This saves separately from product information and is shared by every variant.",
    "Bina halaman butiran teks dan gambar. Ia disimpan berasingan dan dikongsi semua varian.",
    "用文字与图片构建可滚动的详情页。详情独立保存，所有款式共用。",
    "Tạo trang chi tiết cuộn với chữ và ảnh. Lưu riêng và dùng chung cho mọi biến thể.",
    "สร้างหน้ารายละเอียดเลื่อนอ่านได้ด้วยข้อความและภาพ บันทึกแยกและใช้ร่วมทุกตัวเลือก",
    "文章と画像でスクロールする詳細ページを作成します。商品情報とは別に保存し、全バリエーションで共有します。",
    "텍스트와 이미지로 스크롤 상세 페이지를 만드세요. 상품 정보와 별도로 저장되며 모든 옵션이 공유합니다."
  ],
  [
    "empty",
    "No rich detail yet. Shoppers see the product summary.",
    "Belum ada butiran. Pembeli melihat ringkasan produk.",
    "尚无图文详情，买家将看到商品简介。",
    "Chưa có nội dung chi tiết. Khách thấy tóm tắt sản phẩm.",
    "ยังไม่มีรายละเอียด ผู้ซื้อจะเห็นสรุปสินค้า",
    "詳細はまだありません。購入者には商品の概要が表示されます。",
    "상세 내용이 없습니다. 구매자에게 상품 요약이 표시됩니다."
  ],
  [
    "add",
    "Add block",
    "Tambah blok",
    "添加内容块",
    "Thêm khối",
    "เพิ่มบล็อก",
    "ブロック追加",
    "블록 추가"
  ],
  [
    "heading",
    "Heading",
    "Tajuk",
    "标题",
    "Tiêu đề",
    "หัวข้อ",
    "見出し",
    "제목"
  ],
  [
    "paragraph",
    "Paragraph",
    "Perenggan",
    "段落",
    "Đoạn văn",
    "ย่อหน้า",
    "段落",
    "문단"
  ],
  [
    "list",
    "Bullet list",
    "Senarai",
    "项目列表",
    "Danh sách",
    "รายการ",
    "箇条書き",
    "글머리 목록"
  ],
  [
    "image",
    "Image",
    "Gambar",
    "图片",
    "Ảnh",
    "ภาพ",
    "画像",
    "이미지"
  ],
  [
    "specs",
    "Specifications",
    "Spesifikasi",
    "规格参数",
    "Thông số",
    "ข้อมูลจำเพาะ",
    "仕様",
    "사양"
  ],
  [
    "text",
    "Text",
    "Teks",
    "文字内容",
    "Văn bản",
    "ข้อความ",
    "テキスト",
    "텍스트"
  ],
  [
    "bold",
    "Bold paragraph",
    "Perenggan tebal",
    "加粗段落",
    "Đoạn in đậm",
    "ย่อหน้าตัวหนา",
    "段落を太字",
    "문단 굵게"
  ],
  [
    "items",
    "One item per line",
    "Satu item setiap baris",
    "每行一项",
    "Mỗi mục một dòng",
    "หนึ่งรายการต่อบรรทัด",
    "1行に1項目",
    "한 줄에 항목 하나"
  ],
  [
    "rows",
    "One specification per line: label | value",
    "Satu spesifikasi sebaris: label | nilai",
    "每行一个参数：名称 | 数值",
    "Mỗi thông số một dòng: nhãn | giá trị",
    "หนึ่งข้อกำหนดต่อบรรทัด: ชื่อ | ค่า",
    "1行に1つ：項目 | 値",
    "한 줄에 사양 하나: 이름 | 값"
  ],
  [
    "alt",
    "Image description (required)",
    "Penerangan gambar (wajib)",
    "图片说明（必填）",
    "Mô tả ảnh (bắt buộc)",
    "คำอธิบายภาพ (จำเป็น)",
    "画像の説明（必須）",
    "이미지 설명 (필수)"
  ],
  [
    "caption",
    "Caption (optional)",
    "Kapsyen (pilihan)",
    "图注（选填）",
    "Chú thích (tùy chọn)",
    "คำบรรยาย (ไม่บังคับ)",
    "キャプション（任意）",
    "캡션 (선택)"
  ],
  [
    "up",
    "Move up",
    "Naik",
    "上移",
    "Lên",
    "เลื่อนขึ้น",
    "上へ",
    "위로"
  ],
  [
    "down",
    "Move down",
    "Turun",
    "下移",
    "Xuống",
    "เลื่อนลง",
    "下へ",
    "아래로"
  ],
  [
    "remove",
    "Delete block",
    "Padam blok",
    "删除内容块",
    "Xóa khối",
    "ลบบล็อก",
    "ブロック削除",
    "블록 삭제"
  ],
  [
    "saveDetail",
    "Save rich detail",
    "Simpan butiran",
    "保存图文详情",
    "Lưu chi tiết",
    "บันทึกรายละเอียด",
    "詳細を保存",
    "상세 내용 저장"
  ],
  [
    "saved",
    "Rich detail saved.",
    "Butiran disimpan.",
    "图文详情已保存。",
    "Đã lưu chi tiết.",
    "บันทึกรายละเอียดแล้ว",
    "詳細を保存しました。",
    "상세 내용을 저장했습니다."
  ],
  [
    "unsaved",
    "Unsaved detail changes",
    "Butiran belum disimpan",
    "图文详情尚未保存",
    "Chi tiết chưa lưu",
    "รายละเอียดที่ยังไม่บันทึก",
    "詳細に未保存の変更あり",
    "저장하지 않은 상세 변경"
  ],
  [
    "loading",
    "Loading detail…",
    "Memuat butiran…",
    "正在加载详情…",
    "Đang tải chi tiết…",
    "กำลังโหลดรายละเอียด…",
    "詳細を読み込み中…",
    "상세 내용 불러오는 중…"
  ],
  [
    "working",
    "Saving…",
    "Menyimpan…",
    "正在保存…",
    "Đang lưu…",
    "กำลังบันทึก…",
    "保存中…",
    "저장 중…"
  ],
  [
    "reload",
    "Reload saved detail",
    "Muat semula butiran",
    "重新加载已保存的详情",
    "Tải lại chi tiết đã lưu",
    "โหลดรายละเอียดที่บันทึกใหม่",
    "保存済みの詳細を再読込",
    "저장된 상세 다시 불러오기"
  ],
  [
    "failed",
    "Could not save or load detail. Your draft is kept. Retry, or reload saved detail.",
    "Gagal simpan atau muat butiran. Draf dikekalkan. Cuba lagi atau muat semula.",
    "无法保存或加载详情，草稿已保留。请重试，或重新加载已保存的详情。",
    "Không thể lưu hoặc tải chi tiết. Bản nháp được giữ. Thử lại hoặc tải lại.",
    "บันทึกหรือโหลดไม่ได้ เก็บฉบับร่างไว้แล้ว ลองใหม่หรือโหลดข้อมูลที่บันทึก",
    "詳細を保存・読込できませんでした。下書きは保持しています。再試行するか保存済みを再読込してください。",
    "상세 내용을 저장하거나 불러오지 못했습니다. 초안은 유지됩니다. 다시 시도하거나 저장된 내용을 불러오세요."
  ],
  [
    "conflict",
    "Detail changed elsewhere. Copy your draft before reloading saved detail.",
    "Butiran berubah di tempat lain. Salin draf sebelum muat semula.",
    "详情已在别处更改。请先复制草稿，再重新加载已保存的详情。",
    "Chi tiết đã thay đổi ở nơi khác. Sao chép bản nháp trước khi tải lại.",
    "รายละเอียดเปลี่ยนที่อื่น คัดลอกฉบับร่างก่อนโหลดใหม่",
    "詳細が別の場所で変更されました。下書きをコピーしてから保存済みを再読込してください。",
    "상세 내용이 다른 곳에서 변경되었습니다. 저장된 내용을 불러오기 전에 초안을 복사하세요."
  ],
  [
    "invalid",
    "Check every block: text is required, image descriptions are required, and specifications need label | value.",
    "Semak blok: teks, penerangan gambar dan label | nilai diperlukan.",
    "请检查内容块：文字与图片说明为必填，参数须使用名称 | 数值格式。",
    "Kiểm tra khối: cần chữ, mô tả ảnh, thông số nhãn | giá trị.",
    "ตรวจสอบทุกบล็อก ต้องมีข้อความ คำอธิบายภาพและข้อมูลชื่อ | ค่า",
    "各ブロックを確認してください。文章・画像の説明は必須、仕様は項目 | 値の形式です。",
    "각 블록을 확인하세요. 텍스트와 이미지 설명은 필수이며 사양은 이름 | 값 형식이어야 합니다."
  ],
  [
    "imageLimit",
    "Choose a PNG, JPEG or WebP up to 512 KB.",
    "Pilih PNG, JPEG atau WebP sehingga 512 KB.",
    "请选择不超过 512 KB 的 PNG、JPEG 或 WebP。",
    "Chọn PNG, JPEG hoặc WebP tối đa 512 KB.",
    "เลือก PNG JPEG หรือ WebP ไม่เกิน 512 KB",
    "512KB以下のPNG・JPEG・WebPを選んでください。",
    "512KB 이하 PNG, JPEG 또는 WebP를 선택하세요."
  ],
  [
    "blockLimit",
    "Use at most 40 blocks and 20 images.",
    "Maksimum 40 blok dan 20 gambar.",
    "最多支持 40 个内容块及 20 张图片。",
    "Tối đa 40 khối và 20 ảnh.",
    "สูงสุด 40 บล็อกและ 20 ภาพ",
    "最大40ブロック・20画像です。",
    "최대 40개 블록과 20개 이미지입니다."
  ],
  [
    "preview",
    "Buyer preview",
    "Pratonton pembeli",
    "买家预览",
    "Xem trước khách mua",
    "ตัวอย่างผู้ซื้อ",
    "購入者プレビュー",
    "구매자 미리보기"
  ],
  [
    "desktop",
    "Desktop",
    "Desktop",
    "桌面",
    "Máy tính",
    "คอมพิวเตอร์",
    "デスクトップ",
    "데스크톱"
  ],
  [
    "mobile",
    "Mobile",
    "Mudah alih",
    "手机",
    "Điện thoại",
    "มือถือ",
    "モバイル",
    "모바일"
  ],
  [
    "membership",
    "Save or discard rich detail changes before changing the variant group.",
    "Simpan atau buang butiran sebelum menukar kumpulan varian.",
    "更改款式分组前，请先保存或放弃图文详情修改。",
    "Lưu hoặc bỏ chi tiết trước khi đổi nhóm biến thể.",
    "บันทึกหรือยกเลิกรายละเอียดก่อนเปลี่ยนกลุ่มตัวเลือก",
    "グループを変更する前に詳細を保存するか破棄してください。",
    "옵션 그룹을 변경하기 전에 상세 변경을 저장하거나 취소하세요."
  ],
  [
    "membershipConflict",
    "This group change would discard rich detail. Clear or copy the detail first, then try again.",
    "Perubahan kumpulan ini membuang butiran. Kosongkan atau salin dahulu.",
    "此分组更改可能丢失图文详情。请先复制或清空详情，再重试。",
    "Đổi nhóm này sẽ bỏ chi tiết. Xóa hoặc sao chép chi tiết trước.",
    "การเปลี่ยนกลุ่มนี้จะทิ้งรายละเอียด โปรดล้างหรือคัดลอกก่อน",
    "この変更では詳細が失われます。先に詳細をコピーするか空にしてください。",
    "그룹 변경으로 상세 내용이 사라질 수 있습니다. 먼저 내용을 복사하거나 비우세요."
  ]
];
for (const [key, ...values] of rows) locales.forEach((locale, i) => { messages[locale][`pedit_${key}`] = values[i]; });
export const editorText = (key) => t(`pedit_${key}`);
