import { messages } from '../shared/i18n.js';

// Seller-only copy keeps the Customer shell and its cache version unchanged.
export const studioCopy = {
  en: { studioHero: 'Your shop, beautifully managed.', studioHeroIntro: 'A calm workspace for your products, customers and orders.', studioOverview: 'A clear view of what needs your attention.', productInformation: 'Product information', pricingAvailability: 'Pricing & availability', productImages: 'Product images', snapshotCountHelp: 'Counts show up to 100 items. Open a list to see all of them.', countAtLeast: '100+', currencyHistoryNote: 'This product keeps its recorded currency. Price changes or activation require the company currency; no conversion is applied.' },
  ms: { studioHero: 'Kedai anda, diurus dengan kemas.', studioHeroIntro: 'Ruang kerja yang tenang untuk produk, pelanggan dan pesanan.', studioOverview: 'Lihat perkara yang memerlukan perhatian anda.', productInformation: 'Maklumat produk', pricingAvailability: 'Harga & ketersediaan', productImages: 'Imej produk', snapshotCountHelp: 'Kiraan menunjukkan sehingga 100 item. Buka senarai untuk melihat semuanya.', countAtLeast: '100+', currencyHistoryNote: 'Produk ini mengekalkan mata wang yang direkodkan. Perubahan harga atau pengaktifan memerlukan mata wang syarikat; tiada penukaran dibuat.' },
  'zh-Hans': { studioHero: '从容管理您的商店。', studioHeroIntro: '在清晰、舒适的工作空间管理商品、客户和订单。', studioOverview: '清楚掌握需要您处理的事项。', productInformation: '商品信息', pricingAvailability: '价格与销售状态', productImages: '商品图片', snapshotCountHelp: '数量最多显示 100 项。打开列表可查看全部。', countAtLeast: '100+', currencyHistoryNote: '此商品保留原记录币种。改价或重新上架必须符合公司币种；系统不会进行汇率换算。' },
  vi: { studioHero: 'Quản lý cửa hàng thật gọn gàng.', studioHeroIntro: 'Không gian rõ ràng cho sản phẩm, khách hàng và đơn hàng.', studioOverview: 'Nắm rõ những việc cần bạn xử lý.', productInformation: 'Thông tin sản phẩm', pricingAvailability: 'Giá & trạng thái bán', productImages: 'Hình ảnh sản phẩm', snapshotCountHelp: 'Số lượng hiển thị tối đa 100 mục. Mở danh sách để xem tất cả.', countAtLeast: '100+', currencyHistoryNote: 'Sản phẩm giữ tiền tệ đã ghi. Đổi giá hoặc kích hoạt cần tiền tệ của công ty; không áp dụng chuyển đổi.' },
  th: { studioHero: 'จัดการร้านของคุณอย่างลงตัว', studioHeroIntro: 'พื้นที่ทำงานที่สบายตาสำหรับสินค้า ลูกค้า และคำสั่งซื้อ', studioOverview: 'เห็นรายการที่ต้องดูแลได้อย่างชัดเจน', productInformation: 'ข้อมูลสินค้า', pricingAvailability: 'ราคาและสถานะขาย', productImages: 'รูปภาพสินค้า', snapshotCountHelp: 'แสดงตัวเลขสูงสุด 100 รายการ เปิดรายการเพื่อดูทั้งหมด', countAtLeast: '100+', currencyHistoryNote: 'สินค้านี้คงสกุลเงินที่บันทึกไว้ การเปลี่ยนราคาหรือเปิดขายต้องใช้สกุลเงินบริษัท โดยไม่มีการแปลงเงิน' },
  ja: { studioHero: 'ショップ運営を、心地よく。', studioHeroIntro: '商品・顧客・注文を落ち着いた画面で管理。', studioOverview: '対応が必要な項目を、ひと目で確認。', productInformation: '商品情報', pricingAvailability: '価格と販売状態', productImages: '商品画像', snapshotCountHelp: '件数は最大100件まで表示します。すべては一覧で確認できます。', countAtLeast: '100+', currencyHistoryNote: 'この商品は記録済みの通貨を保持します。価格変更や販売再開には会社の通貨が必要です。換算は行いません。' },
  ko: { studioHero: '편안하고 명확한 매장 관리.', studioHeroIntro: '상품, 고객, 주문을 관리하는 차분한 작업 공간.', studioOverview: '처리가 필요한 항목을 한눈에 확인하세요.', productInformation: '상품 정보', pricingAvailability: '가격 및 판매 상태', productImages: '상품 이미지', snapshotCountHelp: '최대 100개까지 표시합니다. 전체는 목록에서 확인하세요.', countAtLeast: '100+', currencyHistoryNote: '이 상품은 기록된 통화를 유지합니다. 가격 변경이나 판매 재개에는 회사 통화가 필요하며 환산하지 않습니다.' },
};

for (const [locale, copy] of Object.entries(studioCopy)) Object.assign(messages[locale], copy);

export function snapshotCount(page) {
  if (!Array.isArray(page?.items)) throw new Error('invalid count page');
  return page.nextOffset !== null && page.nextOffset !== undefined ? '100+' : String(page.items.length);
}
