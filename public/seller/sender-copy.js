import { messages } from '../shared/i18n.js';
const locales = ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko'];
const rows = [
  ['senderTitle', 'Sender / pickup address', 'Pengirim / alamat pengambilan', '寄件人／取件地址', 'Người gửi / địa chỉ lấy hàng', 'ผู้ส่ง / ที่อยู่รับพัสดุ', '発送元／集荷住所', '발송인 / 수거 주소'],
  ['senderName', 'Sender name', 'Nama pengirim', '寄件人姓名', 'Tên người gửi', 'ชื่อผู้ส่ง', '発送元名', '발송인 이름'],
  ['senderPhone', 'Sender phone (+60 / +65)', 'Telefon pengirim (+60 / +65)', '寄件人电话 (+60 / +65)', 'Điện thoại người gửi (+60 / +65)', 'โทรศัพท์ผู้ส่ง (+60 / +65)', '発送元電話 (+60 / +65)', '발송인 전화 (+60 / +65)'],
  ['senderAddressLine1', 'Sender address line 1', 'Alamat pengirim baris 1', '寄件地址第1行', 'Địa chỉ người gửi dòng 1', 'ที่อยู่ผู้ส่งบรรทัด 1', '発送元住所1', '발송인 주소 1'],
  ['senderAddressLine2', 'Sender address line 2', 'Alamat pengirim baris 2', '寄件地址第2行', 'Địa chỉ người gửi dòng 2', 'ที่อยู่ผู้ส่งบรรทัด 2', '発送元住所2', '발송인 주소 2'],
  ['senderCity', 'Sender city', 'Bandar pengirim', '寄件城市', 'Thành phố người gửi', 'เมืองผู้ส่ง', '発送元市区町村', '발송인 도시'],
  ['senderState', 'Sender state', 'Negeri pengirim', '寄件州属', 'Tỉnh người gửi', 'รัฐผู้ส่ง', '発送元都道府県', '발송인 주'],
  ['senderPostcode', 'Sender postcode', 'Poskod pengirim', '寄件邮编', 'Mã bưu điện người gửi', 'รหัสไปรษณีย์ผู้ส่ง', '発送元郵便番号', '발송인 우편번호'],
  ['senderCountry', 'Sender country (ISO code)', 'Negara pengirim (kod ISO)', '寄件国家（ISO代码）', 'Quốc gia người gửi (mã ISO)', 'ประเทศผู้ส่ง (รหัส ISO)', '発送元国（ISOコード）', '발송인 국가 (ISO 코드)'],
  ['shippingExcel', 'Shipping list (Excel)', 'Senarai penghantaran (Excel)', '发货清单 (Excel)', 'Danh sách giao hàng (Excel)', 'รายการจัดส่ง (Excel)', '発送リスト (Excel)', '배송 목록 (Excel)'],
  ['shippingCsv', 'Shipping list (CSV)', 'Senarai penghantaran (CSV)', '发货清单 (CSV)', 'Danh sách giao hàng (CSV)', 'รายการจัดส่ง (CSV)', '発送リスト (CSV)', '배송 목록 (CSV)'],
  ['senderHint', 'Set sender / pickup address in Settings', 'Tetapkan pengirim / alamat pengambilan dalam Tetapan', '在设置中填写寄件人／取件地址', 'Đặt người gửi / địa chỉ lấy hàng trong Cài đặt', 'ตั้งค่าผู้ส่ง / ที่อยู่รับพัสดุในการตั้งค่า', '設定で発送元／集荷住所を登録', '설정에서 발송인 / 수거 주소 등록'],
];
for (const [key, ...values] of rows) locales.forEach((locale, index) => { messages[locale][key] = values[index]; });
