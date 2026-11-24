import { languages, messages } from '../shared/i18n.js';

// English, Malay, Simplified Chinese, Vietnamese, Thai, Japanese, Korean.
const rows = {
  approvalSuccessTitle: ['Approved', 'Diluluskan', '已批准', 'Đã phê duyệt', 'อนุมัติแล้ว', '承認しました', '승인 완료'],
  approvalSuccessContinue: ['Continue', 'Teruskan', '继续', 'Tiếp tục', 'ดำเนินการต่อ', '続ける', '계속'],
  approvalSuccessOperation: ['Seller operation', 'Operasi penjual', '卖家操作', 'Thao tác của người bán', 'การดำเนินการของผู้ขาย', '販売者の操作', '판매자 작업'],
  approvalSuccessProductCreate: ['Product creation', 'Penciptaan produk', '新建商品', 'Tạo sản phẩm', 'สร้างสินค้า', '商品の作成', '상품 생성'],
  approvalSuccessProductUpdate: ['Product changes', 'Perubahan produk', '商品变更', 'Thay đổi sản phẩm', 'เปลี่ยนแปลงสินค้า', '商品の変更', '상품 변경'],
  approvalSuccessCategory: ['Category creation', 'Penciptaan kategori', '新建分类', 'Tạo danh mục', 'สร้างหมวดหมู่', 'カテゴリーの作成', '카테고리 생성'],
  approvalSuccessCompany: ['Company changes', 'Perubahan syarikat', '公司设置变更', 'Thay đổi thông tin công ty', 'เปลี่ยนแปลงข้อมูลบริษัท', '会社設定の変更', '회사 설정 변경'],
  approvalSuccessStock: ['Stock adjustment', 'Pelarasan stok', '库存调整', 'Điều chỉnh tồn kho', 'ปรับสต็อก', '在庫調整', '재고 조정'],
  approvalSuccessOrder: ['Order decision', 'Keputusan pesanan', '订单决定', 'Quyết định về đơn hàng', 'การตัดสินใจเกี่ยวกับคำสั่งซื้อ', '注文に関する判断', '주문 결정'],
  approvalSuccessGalleryAdd: ['Gallery photo addition', 'Penambahan foto galeri', '新增相册照片', 'Thêm ảnh vào bộ sưu tập', 'เพิ่มรูปในแกลเลอรี', 'ギャラリー写真の追加', '갤러리 사진 추가'],
  approvalSuccessPhoto: ['Main photo change', 'Perubahan foto utama', '主图变更', 'Thay đổi ảnh chính', 'เปลี่ยนรูปหลัก', 'メイン写真の変更', '대표 사진 변경'],
  approvalSuccessLayout: ['Image layout change', 'Perubahan susun atur imej', '图片布局变更', 'Thay đổi bố cục ảnh', 'เปลี่ยนการจัดวางรูป', '画像レイアウトの変更', '이미지 배치 변경'],
  approvalSuccessGalleryConfirm: ['Gallery confirmation', 'Pengesahan galeri', '相册确认', 'Xác nhận bộ sưu tập ảnh', 'ยืนยันแกลเลอรี', 'ギャラリーの確認', '갤러리 확인'],
  approvalSuccessWithProduct: ['{operation} · {product}', '{operation} · {product}', '{operation} · {product}', '{operation} · {product}', '{operation} · {product}', '{operation}：{product}', '{operation} · {product}'],
};
const codes = ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko'];
for (const [key, translations] of Object.entries(rows)) {
  codes.forEach((code, index) => { messages[code][key] = translations[index]; });
}

export function approvalSuccessLanguage(preference) {
  const primary = preference?.split('-')[0].toLowerCase();
  const code = primary === 'zh' ? 'zh-Hans' : primary;
  const lang = languages.some(language => language.code === code) ? code : 'en';
  return { lang, t: (key, values = {}) => messages[lang][key].replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match) };
}
