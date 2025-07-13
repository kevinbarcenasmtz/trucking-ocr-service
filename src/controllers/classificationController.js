// src/controllers/classificationController.js
const classificationService = require('../services/classificationService');
const { logger } = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

const classifyReceipt = asyncHandler(async (req, res) => {
  const { extractedText } = req.body;
  const correlationId = req.correlationId;

  if (!extractedText || extractedText.length < 10) {
    return res.status(400).json({
      error: 'Text too short for classification',
      classification: await classificationService.getFallbackClassification(extractedText || ''),
    });
  }

  const result = await classificationService.classifyReceipt(extractedText, correlationId);

  res.json({
    classification: result.data,
    confidence: result.confidence,
    correlationId,
  });
});

module.exports = {
  classifyReceipt,
};