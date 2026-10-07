import { messages } from '../shared/i18n.js';

// Seller-only wording for the document trail and the audit log.
export const trailCopy = {
  en: { documentsTrail: 'Documents', documentNumber: 'Document no.', documentShipment: 'Shipment', documentDelivery: 'Delivery', issuedAt: 'Issued' },
  ms: { documentsTrail: 'Dokumen', documentNumber: 'No. dokumen', documentShipment: 'Penghantaran', documentDelivery: 'Diterima', issuedAt: 'Dikeluarkan' },
  'zh-Hans': { documentsTrail: '单据追踪', documentNumber: '单据号', documentShipment: '发货', documentDelivery: '送达', issuedAt: '开具时间' },
  vi: { documentsTrail: 'Chứng từ', documentNumber: 'Số chứng từ', documentShipment: 'Vận chuyển', documentDelivery: 'Giao hàng', issuedAt: 'Ngày lập' },
  th: { documentsTrail: 'เอกสาร', documentNumber: 'เลขที่เอกสาร', documentShipment: 'การจัดส่ง', documentDelivery: 'ส่งมอบแล้ว', issuedAt: 'ออกเมื่อ' },
  ja: { documentsTrail: '関連書類', documentNumber: '書類番号', documentShipment: '出荷', documentDelivery: '配達完了', issuedAt: '発行日' },
  ko: { documentsTrail: '문서 추적', documentNumber: '문서 번호', documentShipment: '배송', documentDelivery: '배달 완료', issuedAt: '발행일' },
};

for (const [locale, copy] of Object.entries(trailCopy)) Object.assign(messages[locale], copy);
