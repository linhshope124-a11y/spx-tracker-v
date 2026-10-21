export { cancelOcr, preloadTesseractWorker } from './worker.js';

export {
  clearOcrCache, copyOcrLog, fillModalFromResult, openCompareModal,
  openBatchOcrModal, closeBatchOcrModal, appendBatchFiles,
  completeActiveBatchItem, removeBatchItem, importBatchItem,
  backToBatch, showBackToBatchBtn, hasBatchPending, saveBatchAll,
  applyConfidenceHighlight, openOcrLightbox, closeOcrLightbox,
  handleOcrImage, handleSharedImage
} from './batch.js';

export { getOcrCacheStats, initOcrCache, refreshOcrCacheStats } from '../ocr-cache.js';

import { parseOcrText, extractDateStrict, postProcessFixDigits, identifyRangeKey } from './parser.js';

export const __test = {
  parseOcrText, extractDateStrict, postProcessFixDigits, identifyRangeKey
};
