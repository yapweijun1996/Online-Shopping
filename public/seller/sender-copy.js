import { messages } from '../shared/i18n.js';
const locales = ['en', 'ms', 'zh-Hans', 'vi', 'th', 'ja', 'ko'];
const rows = [
  ["senderDetails", "Sender details", "Butiran pengirim", "寄件资料", "Thông tin người gửi", "ข้อมูลผู้ส่ง", "発送元情報", "발송인 정보"],
  ["senderAddressLine2Optional", "Sender address line 2 (optional)", "Alamat pengirim baris 2 (pilihan)", "寄件地址第2行（选填）", "Địa chỉ người gửi dòng 2 (tùy chọn)", "ที่อยู่ผู้ส่งบรรทัด 2 (ตัวเลือก)", "発送元住所2（任意）", "발송인 주소 2 (선택 사항)"],

  ['companySaveUnconfirmed', 'Could not confirm the saved settings. Your draft is kept; retry or reload to verify.', 'Tetapan tersimpan tidak dapat disahkan. Draf dikekalkan; cuba lagi atau muat semula untuk menyemak.', '无法确认保存结果，已保留草稿。请重试或重新读取以核实。', 'Không xác nhận được kết quả lưu. Giữ bản nháp; thử lại hoặc tải lại để kiểm tra.', 'ยืนยันผลการบันทึกไม่ได้ เก็บแบบร่างไว้แล้ว ลองอีกครั้งหรือโหลดใหม่เพื่อตรวจ', '保存結果を確認できませんでした。下書きは保持しています。再試行するか再読み込みで確認してください。', '저장 결과를 확인하지 못했습니다. 초안은 유지됩니다. 다시 시도하거나 다시 불러와 확인하세요.'],
  ['senderContact', 'Contact', 'Hubungan', '联系信息', 'Liên hệ', 'ข้อมูลติดต่อ', '連絡先', '연락처'],
  ['senderAddress', 'Address', 'Alamat', '寄件地址', 'Địa chỉ', 'ที่อยู่', '住所', '주소'],
  ['senderOptional', 'All sender fields are optional. These details are used in shipping exports.', 'Semua medan pengirim pilihan. Butiran digunakan dalam eksport penghantaran.', '所有寄件字段均为选填，用于发货导出。', 'Mọi trường người gửi đều tùy chọn, dùng trong dữ liệu xuất giao hàng.', 'ทุกช่องเป็นตัวเลือก ข้อมูลใช้ในการส่งออกรายการจัดส่ง', 'すべて任意項目です。発送リストの出力に使用します。', '모든 발송인 필드는 선택 사항이며 배송 내보내기에 사용됩니다.'],
  ["senderPhoneHelp", "Enter the complete +60 or +65 phone number, or leave blank.", "Masukkan nombor penuh +60 atau +65, atau biarkan kosong.", "请填写完整的 +60 或 +65 电话号码，或留空。", "Nhập đầy đủ số +60 hoặc +65 hoặc để trống.", "กรอกหมายเลข +60 หรือ +65 แบบเต็ม หรือเว้นว่าง", "完全な +60 または +65 の電話番号を入力するか、空欄にします。", "완전한 +60 또는 +65 전화번호를 입력하거나 비워 두세요."],
  ['senderSave', 'Save sender details', 'Simpan butiran pengirim', '保存寄件信息', 'Lưu thông tin người gửi', 'บันทึกข้อมูลผู้ส่ง', '発送元情報を保存', '발송인 정보 저장'],
  ['senderSaved', 'Sender details saved.', 'Butiran pengirim disimpan.', '寄件信息已保存。', 'Đã lưu thông tin người gửi.', 'บันทึกข้อมูลผู้ส่งแล้ว', '発送元情報を保存しました。', '발송인 정보를 저장했습니다.'],
  ['companySaving', 'Saving…', 'Menyimpan…', '正在保存…', 'Đang lưu…', 'กำลังบันทึก…', '保存中…', '저장 중…'],
  ['companyUnsaved', 'Unsaved changes', 'Perubahan belum disimpan', '有未保存的修改', 'Thay đổi chưa lưu', 'มีการเปลี่ยนแปลงที่ยังไม่บันทึก', '未保存の変更', '저장되지 않은 변경 사항'],
  ['companySaveFailed', 'Could not save. Your changes are kept; correct any marked field and try again.', 'Tidak dapat menyimpan. Perubahan dikekalkan; betulkan medan bertanda dan cuba lagi.', '保存失败，已保留修改。请检查标记字段后重试。', 'Không lưu được. Giữ nguyên thay đổi; sửa trường đánh dấu và thử lại.', 'บันทึกไม่ได้ เก็บการเปลี่ยนแปลงไว้แล้ว แก้ช่องที่ระบุและลองอีกครั้ง', '保存できませんでした。変更は保持されています。表示された項目を修正して再試行してください。', '저장하지 못했습니다. 변경 사항은 유지됩니다. 표시된 필드를 수정하고 다시 시도하세요.'],
  ['companyForbidden', 'You no longer have permission to save these settings.', 'Anda tidak lagi dibenarkan menyimpan tetapan ini.', '您目前没有保存这些设置的权限。', 'Bạn không còn quyền lưu cài đặt này.', 'คุณไม่มีสิทธิ์บันทึกการตั้งค่านี้แล้ว', 'この設定を保存する権限がありません。', '이 설정을 저장할 권한이 없습니다.'],
  ['senderCountryBlank', 'Not set (optional)', 'Tidak ditetapkan (pilihan)', '未设置（选填）', 'Chưa đặt (tùy chọn)', 'ไม่ระบุ (ตัวเลือก)', '未設定（任意）', '미설정 (선택 사항)'],
  ['senderCountryOther', 'Other two-letter code', 'Kod dua huruf lain', '其他两字母代码', 'Mã hai chữ cái khác', 'รหัสสองตัวอักษรอื่น', 'その他の2文字コード', '다른 두 글자 코드'],
  ["senderCountryHelp", "Choose a country or enter an uppercase two-letter code.", "Pilih negara atau masukkan kod dua huruf besar.", "请选择国家，或填写两位大写字母代码。", "Chọn quốc gia hoặc nhập mã hai chữ cái in hoa.", "เลือกประเทศหรือกรอกรหัสตัวพิมพ์ใหญ่สองตัว", "国を選択するか、大文字2文字のコードを入力します。", "국가를 선택하거나 대문자 두 글자 코드를 입력하세요."],

  ['senderTitle', 'Sender / pickup address', 'Pengirim / alamat pengambilan', '寄件人／取件地址', 'Người gửi / địa chỉ lấy hàng', 'ผู้ส่ง / ที่อยู่รับพัสดุ', '発送元／集荷住所', '발송인 / 수거 주소'],
  ['senderName', 'Sender name', 'Nama pengirim', '寄件人姓名', 'Tên người gửi', 'ชื่อผู้ส่ง', '発送元名', '발송인 이름'],
  ['senderPhone', 'Sender phone (+60 / +65)', 'Telefon pengirim (+60 / +65)', '寄件人电话 (+60 / +65)', 'Điện thoại người gửi (+60 / +65)', 'โทรศัพท์ผู้ส่ง (+60 / +65)', '発送元電話 (+60 / +65)', '발송인 전화 (+60 / +65)'],
  ['senderAddressLine1', 'Sender address line 1', 'Alamat pengirim baris 1', '寄件地址第1行', 'Địa chỉ người gửi dòng 1', 'ที่อยู่ผู้ส่งบรรทัด 1', '発送元住所1', '발송인 주소 1'],
  ['senderAddressLine2', 'Sender address line 2', 'Alamat pengirim baris 2', '寄件地址第2行', 'Địa chỉ người gửi dòng 2', 'ที่อยู่ผู้ส่งบรรทัด 2', '発送元住所2', '발송인 주소 2'],
  ['senderCity', 'Sender city', 'Bandar pengirim', '寄件城市', 'Thành phố người gửi', 'เมืองผู้ส่ง', '発送元市区町村', '발송인 도시'],
  ['senderState', 'Sender state', 'Negeri pengirim', '寄件州属', 'Tỉnh người gửi', 'รัฐผู้ส่ง', '発送元都道府県', '발송인 주'],
  ['senderPostcode', 'Sender postcode', 'Poskod pengirim', '寄件邮编', 'Mã bưu điện người gửi', 'รหัสไปรษณีย์ผู้ส่ง', '発送元郵便番号', '발송인 우편번호'],
  ['senderCountry', 'Sender country', 'Negara pengirim', '寄件国家', 'Quốc gia người gửi', 'ประเทศผู้ส่ง', '発送元国', '발송인 국가'],
  ['shippingExcel', 'Shipping list (Excel)', 'Senarai penghantaran (Excel)', '发货清单 (Excel)', 'Danh sách giao hàng (Excel)', 'รายการจัดส่ง (Excel)', '発送リスト (Excel)', '배송 목록 (Excel)'],
  ['shippingCsv', 'Shipping list (CSV)', 'Senarai penghantaran (CSV)', '发货清单 (CSV)', 'Danh sách giao hàng (CSV)', 'รายการจัดส่ง (CSV)', '発送リスト (CSV)', '배송 목록 (CSV)'],
  ['senderInvalid', 'Check the sender / pickup address. The phone must be a valid +60 or +65 phone number and the country an uppercase 2-letter code such as MY.', 'Semak pengirim / alamat pengambilan. Telefon mestilah nombor telefon +60 atau +65 dan negara kod 2 huruf besar seperti MY.', '请检查寄件人／取件地址：电话必须是 +60 或 +65 有效电话号码，国家须为两个大写字母的代码，例如 MY。', 'Kiểm tra người gửi / địa chỉ lấy hàng. Số điện thoại phải là số điện thoại +60 hoặc +65 và quốc gia là mã 2 chữ cái in hoa, ví dụ MY.', 'ตรวจสอบผู้ส่ง / ที่อยู่รับพัสดุ เบอร์โทรต้องเป็นเบอร์โทร +60 หรือ +65 และประเทศเป็นรหัส 2 ตัวอักษรพิมพ์ใหญ่ เช่น MY', '発送元／集荷住所を確認してください。電話は +60 または +65 の電話番号、国は MY のような大文字2文字のコードです。', '발송인 / 수거 주소를 확인하세요. 전화번호는 +60 또는 +65 전화번호, 국가는 MY와 같은 대문자 2자 코드여야 합니다.'],
  ['senderHint', 'Set sender / pickup address in Settings', 'Tetapkan pengirim / alamat pengambilan dalam Tetapan', '在设置中填写寄件人／取件地址', 'Đặt người gửi / địa chỉ lấy hàng trong Cài đặt', 'ตั้งค่าผู้ส่ง / ที่อยู่รับพัสดุในการตั้งค่า', '設定で発送元／集荷住所を登録', '설정에서 발송인 / 수거 주소 등록'],
];
for (const [key, ...values] of rows) locales.forEach((locale, index) => { messages[locale][key] = values[index]; });
