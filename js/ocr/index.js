// =============================================================
// OCR INDEX — Cửa ngõ xuất API
// Gom các hàm từ worker, batch, parser và cache để main.js sử dụng
// =============================================================

export { cancelOcr, preloadTesseractWorker } from './worker.js';

export {
  clearOcrCache, copyOcrLog, fillModalFromResult, openCompareModal,
  openBatchOcrModal, closeBatchOcrModal, appendBatchFiles,
  completeActiveBatchItem, removeBatchItem, importBatchItem,
  backToBatch, showBackToBatchBtn, hasBatchPending, saveBatchAll,
  applyConfidenceHighlight, openOcrLightbox, closeOcrLightbox,
  handleOcrImage, handleSharedImage, setBatch, getBatch
} from './batch.js';

export { getOcrCacheStats, initOcrCache, refreshOcrCacheStats } from '../ocr-cache.js';

// Chỉ phục vụ unit test (tests/) — app không dùng
import { parseOcrText, extractDateStrict, postProcessFixDigits, identifyRangeKey } from './parser.js';
import { setBatch, getBatch } from './batch.js';

export const __test = {
  parseOcrText, extractDateStrict, postProcessFixDigits, identifyRangeKey,
  setBatch, getBatch
};