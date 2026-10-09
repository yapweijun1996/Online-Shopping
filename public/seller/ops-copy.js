import { messages } from '../shared/i18n.js';

// Seller-only wording for erasing contact data, the dashboard figures, order filters, CSV export and accounts.
// One row per key: English, Malay, Simplified Chinese, Vietnamese, Thai, Japanese, Korean.
const LOCALES = ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko'];
const rows = [
  ['eraseContact', 'Erase contact data', 'Padam data hubungan', '删除联系方式', 'Xóa dữ liệu liên hệ', 'ลบข้อมูลติดต่อ', '連絡先データを削除', '연락처 데이터 삭제'],
  ['eraseIntro', 'This permanently removes the buyer name, phone, email, delivery names and addresses, and buyer reply texts for this order. The order number, items, amounts and history stay. It cannot be undone.',
    'Ini memadam nama, telefon, e-mel, nama dan alamat penghantaran serta teks balasan pembeli bagi pesanan ini secara kekal. Nombor pesanan, item, jumlah dan sejarah kekal. Tindakan ini tidak boleh dibatalkan.',
    '这将永久删除此订单的买家姓名、电话、邮箱、收件人姓名和地址以及买家回复内容。订单号、商品、金额和历史记录会保留。此操作无法撤销。',
    'Thao tác này xóa vĩnh viễn tên, điện thoại, email, tên và địa chỉ giao hàng cùng nội dung tin nhắn trả lời của người mua trong đơn này. Mã đơn, sản phẩm, số tiền và lịch sử được giữ lại. Không thể hoàn tác.',
    'การดำเนินการนี้จะลบชื่อ โทรศัพท์ อีเมล ชื่อและที่อยู่จัดส่ง และข้อความตอบกลับของผู้ซื้อในคำสั่งซื้อนี้อย่างถาวร หมายเลขคำสั่งซื้อ สินค้า ยอดเงิน และประวัติจะยังอยู่ ย้อนกลับไม่ได้',
    'この注文の購入者名・電話・メール・配送先の氏名と住所・購入者の返信文を完全に削除します。注文番号、商品、金額、履歴は残ります。元に戻せません。',
    '이 주문의 구매자 이름, 전화, 이메일, 배송지 이름과 주소, 구매자 답장 내용이 영구 삭제됩니다. 주문번호, 상품, 금액, 이력은 남습니다. 되돌릴 수 없습니다.'],
  ['eraseConfirmLabel', 'Type the order number to confirm', 'Taip nombor pesanan untuk mengesahkan', '输入订单号以确认', 'Nhập mã đơn để xác nhận', 'พิมพ์หมายเลขคำสั่งซื้อเพื่อยืนยัน', '確認のため注文番号を入力', '확인하려면 주문번호를 입력하세요'],
  ['eraseConfirmButton', 'Erase permanently', 'Padam secara kekal', '永久删除', 'Xóa vĩnh viễn', 'ลบถาวร', '完全に削除', '영구 삭제'],
  ['eraseMismatch', 'The order number does not match.', 'Nombor pesanan tidak sepadan.', '订单号不匹配。', 'Mã đơn không khớp.', 'หมายเลขคำสั่งซื้อไม่ตรงกัน', '注文番号が一致しません。', '주문번호가 일치하지 않습니다.'],
  ['eraseFailed', 'Could not erase the data. Reload and try again.', 'Tidak dapat memadam data. Muat semula dan cuba lagi.', '无法删除数据。请刷新后重试。', 'Không thể xóa dữ liệu. Hãy tải lại và thử lại.', 'ลบข้อมูลไม่สำเร็จ โหลดใหม่แล้วลองอีกครั้ง', 'データを削除できませんでした。再読み込みしてやり直してください。', '데이터를 삭제할 수 없습니다. 새로고침 후 다시 시도하세요.'],
  ['eraseDone', 'Contact data erased.', 'Data hubungan telah dipadam.', '联系方式已删除。', 'Đã xóa dữ liệu liên hệ.', 'ลบข้อมูลติดต่อแล้ว', '連絡先データを削除しました。', '연락처 데이터를 삭제했습니다.'],
  ['eraseOnlyFinished', 'Contact data can be erased once the order is rejected, delivered or cancelled.', 'Data hubungan boleh dipadam selepas pesanan ditolak, dihantar atau dibatalkan.', '订单被拒绝、已送达或已取消后才能删除联系方式。', 'Chỉ xóa được dữ liệu liên hệ khi đơn đã bị từ chối, đã giao hoặc đã hủy.', 'ลบข้อมูลติดต่อได้เมื่อคำสั่งซื้อถูกปฏิเสธ จัดส่งแล้ว หรือยกเลิกแล้ว', '注文が拒否・配達済み・キャンセルになった後に削除できます。', '주문이 거절·배송 완료·취소된 후에 삭제할 수 있습니다.'],
  ['contactErasedNote', 'Contact data was erased on {when} by {who}.', 'Data hubungan dipadam pada {when} oleh {who}.', '联系方式已于 {when} 由 {who} 删除。', 'Dữ liệu liên hệ đã được {who} xóa vào {when}.', 'ข้อมูลติดต่อถูกลบเมื่อ {when} โดย {who}', '連絡先データは {when} に {who} が削除しました。', '연락처 데이터는 {when}에 {who}님이 삭제했습니다.'],
  ['contactErasedChip', 'Contact erased', 'Hubungan dipadam', '联系方式已删除', 'Đã xóa liên hệ', 'ลบข้อมูลติดต่อแล้ว', '連絡先削除済み', '연락처 삭제됨'],
];
for (const row of rows) LOCALES.forEach((locale, index) => { messages[locale][row[0]] = row[index + 1]; });
