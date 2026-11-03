import { messages } from '../shared/i18n.js';
const locales = ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko'];
const rows = [
  ['aist_analyzeCost', 'Analysis: 1 AI call. Your daily limit applies.', 'Analisis: 1 panggilan AI. Had harian anda terpakai.', '分析：1 次 AI 调用，受每日上限限制。', 'Phân tích: 1 lượt gọi AI. Áp dụng giới hạn hằng ngày.', 'วิเคราะห์ใช้ AI 1 ครั้ง อยู่ภายใต้ขีดจำกัดรายวัน', '分析：AI呼び出し1回。1日の上限が適用されます。', '분석: AI 호출 1회. 일일 한도가 적용됩니다.'],
  ['aist_dropHint', 'Drop a photo here, or choose a file. PNG, JPEG or WebP; prepared photo up to 512 KB.', 'Lepaskan foto di sini atau pilih fail. PNG, JPEG atau WebP; foto disediakan sehingga 512 KB.', '拖放照片或选择文件。支持 PNG、JPEG、WebP；处理后不超过 512 KB。', 'Thả ảnh vào đây hoặc chọn tệp. PNG, JPEG hoặc WebP; ảnh xử lý tối đa 512 KB.', 'วางรูปที่นี่หรือเลือกไฟล์ PNG, JPEG หรือ WebP รูปที่เตรียมแล้วไม่เกิน 512 KB', '写真をドロップするかファイルを選択。PNG・JPEG・WebP、処理後512KBまで。', '사진을 놓거나 파일을 선택하세요. PNG, JPEG, WebP, 처리 후 최대 512KB.'],
  ['aist_previewHint', 'No photo preview yet.', 'Belum ada pratonton foto.', '尚无照片预览。', 'Chưa có ảnh xem trước.', 'ยังไม่มีรูปตัวอย่าง', '写真のプレビューはまだありません。', '사진 미리보기가 아직 없습니다.'],
  ['aist_replacePhoto', 'Replace photo', 'Ganti foto', '替换照片', 'Thay ảnh', 'เปลี่ยนรูป', '写真を変更', '사진 바꾸기'],
  ['aist_removePhoto', 'Remove photo', 'Buang foto', '移除照片', 'Xóa ảnh', 'ลบรูป', '写真を削除', '사진 제거'],
  ['aist_discardPhoto', 'This will discard the unsaved suggestions for this photo. Continue?', 'Ini membuang cadangan belum disimpan untuk foto ini. Teruskan?', '这将丢弃此照片尚未保存的建议。继续吗？', 'Thao tác sẽ bỏ gợi ý chưa lưu của ảnh này. Tiếp tục?', 'การดำเนินการนี้จะทิ้งคำแนะนำที่ยังไม่บันทึกของรูปนี้ ดำเนินการต่อหรือไม่', 'この写真の未保存の提案を破棄します。続けますか？', '이 사진의 저장하지 않은 제안을 버립니다. 계속할까요?'],
  ['aist_editSaved', 'Edit saved product', 'Sunting produk disimpan', '编辑已保存的商品', 'Sửa sản phẩm đã lưu', 'แก้ไขสินค้าที่บันทึก', '保存した商品を編集', '저장한 상품 편집'],
  ['aist_imagesSaved', 'Create images for this draft', 'Cipta imej untuk draf ini', '为此草稿生成图片', 'Tạo ảnh cho bản nháp này', 'สร้างภาพสำหรับฉบับร่างนี้', 'この下書きの画像を作成', '이 초안의 이미지 만들기'],

  ['aist_createTask', 'Create Product', 'Cipta Produk', '创建商品', 'Tạo sản phẩm', 'สร้างสินค้า', '商品を作成', '상품 만들기'],
  ['aist_imagesTask', 'Generate Images', 'Jana Imej', '生成图片', 'Tạo ảnh', 'สร้างภาพ', '画像を生成', '이미지 생성'],
  ['aist_source', 'Source photo', 'Foto sumber', '源照片', 'Ảnh nguồn', 'รูปต้นฉบับ', '元の写真', '원본 사진'],
  ['aist_suggestions', 'AI Suggestions', 'Cadangan AI', 'AI 建议', 'Gợi ý AI', 'คำแนะนำ AI', 'AIの提案', 'AI 제안'],
  ['aist_output', 'Generated outputs', 'Hasil janaan', '生成结果', 'Kết quả tạo ảnh', 'ผลลัพธ์ที่สร้าง', '生成結果', '생성 결과'],
  ['aist_createEmpty', 'Your editable suggestions will appear here after analysis.', 'Cadangan boleh sunting muncul di sini selepas analisis.', '分析后，可编辑的建议将显示在这里。', 'Gợi ý có thể sửa sẽ xuất hiện ở đây sau khi phân tích.', 'คำแนะนำที่แก้ไขได้จะแสดงที่นี่หลังวิเคราะห์', '分析後、編集可能な提案がここに表示されます。', '분석 후 편집 가능한 제안이 여기에 표시됩니다.'],
  ['aist_imagesEmpty', 'Generated images and per-style results will appear here.', 'Imej dan hasil setiap gaya akan muncul di sini.', '生成图片和各风格结果将显示在这里。', 'Ảnh tạo và kết quả từng phong cách sẽ xuất hiện ở đây.', 'ภาพและผลลัพธ์แต่ละสไตล์จะแสดงที่นี่', '生成画像とスタイルごとの結果がここに表示されます。', '생성 이미지와 스타일별 결과가 여기에 표시됩니다.'],
  ['aist_analyzePhoto', 'Analyze product photo', 'Analisis foto produk', '分析商品照片', 'Phân tích ảnh sản phẩm', 'วิเคราะห์รูปสินค้า', '商品写真を分析', '상품 사진 분석'],
  ['aist_noProduct', 'Select a product first.', 'Pilih produk dahulu.', '请先选择商品。', 'Hãy chọn sản phẩm trước.', 'เลือกสินค้าก่อน', '先に商品を選んでください。', '먼저 상품을 선택하세요.'],
  ['aist_stepUpload', 'Step 1 · Upload photo', 'Langkah 1 · Muat naik foto', '第 1 步 · 上传照片', 'Bước 1 · Tải ảnh lên', 'ขั้นที่ 1 · อัปโหลดรูป', 'ステップ1 · 写真をアップロード', '1단계 · 사진 업로드'],
  ['aist_stepAnalyze', 'Step 2 · Analyze and review', 'Langkah 2 · Analisis dan semak', '第 2 步 · 分析与检查', 'Bước 2 · Phân tích và xem lại', 'ขั้นที่ 2 · วิเคราะห์และตรวจสอบ', 'ステップ2 · 分析して確認', '2단계 · 분석 및 검토'],
  ['aist_stepSave', 'Step 3 · Save draft', 'Langkah 3 · Simpan draf', '第 3 步 · 保存草稿', 'Bước 3 · Lưu bản nháp', 'ขั้นที่ 3 · บันทึกฉบับร่าง', 'ステップ3 · 下書きを保存', '3단계 · 초안 저장'],
  ['aist_stepProduct', 'Step 1 · Select product', 'Langkah 1 · Pilih produk', '第 1 步 · 选择商品', 'Bước 1 · Chọn sản phẩm', 'ขั้นที่ 1 · เลือกสินค้า', 'ステップ1 · 商品を選択', '1단계 · 상품 선택'],
  ['aist_stepStyle', 'Step 2 · Choose styles', 'Langkah 2 · Pilih gaya', '第 2 步 · 选择风格', 'Bước 2 · Chọn phong cách', 'ขั้นที่ 2 · เลือกสไตล์', 'ステップ2 · スタイルを選択', '2단계 · 스타일 선택'],
  ['aist_stepGenerate', 'Step 3 · Generate and review', 'Langkah 3 · Jana dan semak', '第 3 步 · 生成与检查', 'Bước 3 · Tạo và xem lại', 'ขั้นที่ 3 · สร้างและตรวจสอบ', 'ステップ3 · 生成して確認', '3단계 · 생성 및 검토'],

  ['p1Unchanged', 'No unsaved changes', 'Tiada perubahan belum disimpan', '没有未保存的更改', 'Không có thay đổi chưa lưu', 'ไม่มีการเปลี่ยนแปลงที่ยังไม่บันทึก', '未保存の変更はありません', '저장하지 않은 변경 사항 없음'],
  ['p1Unsaved', 'Unsaved changes', 'Perubahan belum disimpan', '有未保存的更改', 'Thay đổi chưa lưu', 'มีการเปลี่ยนแปลงที่ยังไม่บันทึก', '未保存の変更', '저장하지 않은 변경 사항'],
  ['p1Saving', 'Saving…', 'Menyimpan…', '正在保存…', 'Đang lưu…', 'กำลังบันทึก…', '保存中…', '저장 중…'],
  ['p1Saved', 'Saved', 'Disimpan', '已保存', 'Đã lưu', 'บันทึกแล้ว', '保存済み', '저장됨'],
  ['p1SaveError', 'Could not save. Your edits are kept.', 'Tidak dapat menyimpan. Suntingan dikekalkan.', '无法保存，编辑内容已保留。', 'Không thể lưu. Nội dung sửa được giữ lại.', 'บันทึกไม่ได้ การแก้ไขยังอยู่', '保存できませんでした。編集は保持されています。', '저장하지 못했습니다. 편집 내용은 유지됩니다.'],
  ['p1VariantExample', 'Example: group BOWL / option Small / SKU BOWL-S. Category describes the type of product, not its variants.', 'Contoh: kumpulan BOWL / pilihan Kecil / SKU BOWL-S. Kategori menerangkan jenis produk, bukan variannya.', '示例：组 BOWL / 选项 Small / SKU BOWL-S。分类描述商品类型，不是规格。', 'Ví dụ: nhóm BOWL / lựa chọn Nhỏ / SKU BOWL-S. Danh mục mô tả loại sản phẩm, không phải biến thể.', 'ตัวอย่าง กลุ่ม BOWL / ตัวเลือก เล็ก / SKU BOWL-S หมวดหมู่อธิบายประเภทสินค้า ไม่ใช่ตัวเลือก', '例：グループ BOWL / オプション Small / SKU BOWL-S。カテゴリは商品の種類で、バリエーションとは異なります。', '예: 그룹 BOWL / 옵션 Small / SKU BOWL-S. 카테고리는 상품 종류이며 변형이 아닙니다.'],
  ['p1StockHelp', 'Turn off unlimited to enter a quantity. Zero means out of stock.', 'Matikan tanpa had untuk memasukkan kuantiti. Sifar bermaksud kehabisan stok.', '关闭无限库存后输入数量。零表示缺货。', 'Tắt không giới hạn để nhập số lượng. Số không là hết hàng.', 'ปิดไม่จำกัดเพื่อระบุจำนวน ศูนย์หมายถึงสินค้าหมด', '数量を入力するには無制限をオフにします。0は在庫切れです。', '수량을 입력하려면 무제한을 끄세요. 0은 품절입니다.'],
  ['p1StockInvalid', 'Enter a whole quantity from 0 to 1,000,000, or choose unlimited stock.', 'Masukkan kuantiti bulat 0 hingga 1,000,000 atau pilih stok tanpa had.', '请输入 0 至 1,000,000 的整数，或选择无限库存。', 'Nhập số nguyên từ 0 đến 1.000.000 hoặc chọn tồn kho không giới hạn.', 'ระบุจำนวนเต็ม 0 ถึง 1,000,000 หรือเลือกสต็อกไม่จำกัด', '0〜1,000,000の整数を入力するか、在庫無制限を選んでください。', '0~1,000,000의 정수를 입력하거나 무제한 재고를 선택하세요.'],
];
for (const [key, ...values] of rows) locales.forEach((locale, index) => { messages[locale][key] = values[index]; });
