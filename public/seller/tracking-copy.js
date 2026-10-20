import { messages } from '../shared/i18n.js';
const locales = ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko'];
const rows = [
  ['trackingPrevious', 'Previous', 'Sebelumnya', '上一页', 'Trước', 'ก่อนหน้า', '前へ', '이전'],
  ['trackingNext', 'Next', 'Seterusnya', '下一页', 'Tiếp', 'ถัดไป', '次へ', '다음'],
  ['trackingOrder', 'Order number', 'Nombor pesanan', '订单号', 'Mã đơn', 'หมายเลขคำสั่งซื้อ', '注文番号', '주문번호'],
  ['trackingImport', 'Import tracking CSV', 'Import CSV penjejakan', '导入物流 CSV', 'Nhập CSV vận đơn', 'นำเข้า CSV ติดตาม', '追跡CSVを読み込む', '배송 추적 CSV 가져오기'],
  ['trackingTemplate', 'Download tracking template', 'Muat turun templat penjejakan', '下载物流模板', 'Tải mẫu vận đơn', 'ดาวน์โหลดแม่แบบติดตาม', '追跡テンプレートを取得', '배송 추적 양식 다운로드'],
  ['trackingIntro', 'Shop format, up to 500 records. Import only after dispatch, not merely booking. Dates are declarations in the audit history; audit timestamps stay at commit time. Import identifiers as text in spreadsheets.', 'Format kedai, sehingga 500 rekod. Import hanya selepas penghantaran, bukan tempahan sahaja. Tarikh ialah pengisytiharan dalam sejarah audit; masa audit kekal masa import. Import pengecam sebagai teks dalam hamparan.', '商店格式，最多500条。仅在实际发货后导入，预约不代表发货。日期仅作为审计备注，审计时间仍为提交时间。请在表格中将编号作为文本导入。', 'Định dạng cửa hàng, tối đa 500 bản ghi. Chỉ nhập sau khi gửi hàng, không phải chỉ đặt vận chuyển. Ngày là khai báo trong lịch sử; thời gian kiểm toán là lúc lưu. Nhập mã dưới dạng văn bản trong bảng tính.', 'รูปแบบร้าน สูงสุด 500 รายการ นำเข้าหลังส่งสินค้าจริง ไม่ใช่แค่จอง วันที่เป็นบันทึกในประวัติ เวลาตรวจสอบยังเป็นเวลายืนยัน นำเข้ารหัสเป็นข้อความในตาราง', '店舗形式、最大500件。予約だけでなく発送後に読み込んでください。日付は監査履歴の申告で、記録時刻は確定時刻です。表計算では識別子を文字列として読み込んでください。', '상점 형식, 최대 500건. 예약만 한 상태가 아니라 실제 발송 후 가져오세요. 날짜는 감사 이력의 신고이며 기록 시각은 확정 시각입니다. 스프레드시트에서 식별자는 텍스트로 가져오세요.'],
  ['trackingShipCount', 'Mark {count} orders SHIPPED', 'Tandakan {count} pesanan DIHANTAR', '将 {count} 个订单标为已发货', 'Đánh dấu {count} đơn ĐÃ GỬI', 'ทำเครื่องหมาย {count} คำสั่งซื้อว่าส่งแล้ว', '{count}件を発送済みにする', '{count}건을 발송됨으로 표시'],
  ['trackingReport', 'Download validation report', 'Muat turun laporan pengesahan', '下载验证报告', 'Tải báo cáo xác thực', 'ดาวน์โหลดรายงานตรวจสอบ', '検証レポートを取得', '검증 보고서 다운로드'],
  ['trackingPreview', 'Preview again', 'Pratonton semula', '重新预览', 'Xem trước lại', 'ดูตัวอย่างอีกครั้ง', '再プレビュー', '다시 미리보기'],
  ['trackingUnknown', 'Outcome unknown; preview the same file again before continuing.', 'Hasil tidak diketahui; pratonton fail yang sama sebelum meneruskan.', '结果未知；请先重新预览同一文件。', 'Chưa rõ kết quả; xem trước lại cùng tệp trước khi tiếp tục.', 'ไม่ทราบผล โปรดดูตัวอย่างไฟล์เดิมอีกครั้งก่อนดำเนินการต่อ', '結果不明。同じファイルを再プレビューしてください。', '결과를 알 수 없습니다. 계속하기 전에 같은 파일을 다시 미리보세요.'],
  ['trackingDone', 'Import complete: {count} orders shipped.', 'Import selesai: {count} pesanan dihantar.', '导入完成：{count} 个订单已发货。', 'Nhập xong: đã gửi {count} đơn.', 'นำเข้าเสร็จ: ส่งแล้ว {count} คำสั่งซื้อ', '完了：{count}件を発送済みにしました。', '완료: {count}건 발송됨.'],
];
for (const [key, ...values] of rows) locales.forEach((locale, index) => { messages[locale][key] = values[index]; });
