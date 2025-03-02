const express = require('express');
const { createWorker } = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// Set up Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Add a simple home route
app.get('/', (req, res) => {
  res.send('OCR Service is running. Send POST requests to /api/ocr/base64');
});

// Handle base64 image uploads
app.post('/api/ocr/base64', async (req, res) => {
  try {
    const { image } = req.body;
    
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }
    
    // Ensure uploads directory exists
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    
    // Extract base64 data - handle different possible formats
    let base64Data = image;
    if (image.includes(',')) {
      base64Data = image.split(',')[1];
    }
    
    // Save base64 image to file system temporarily
    const imagePath = path.join(uploadDir, `${Date.now()}.jpg`);
    fs.writeFileSync(imagePath, Buffer.from(base64Data, 'base64'));
    
    // Process with OCR
    const text = await processOCR(imagePath);
    
    // Clean up temp file
    fs.unlinkSync(imagePath);
    
    // Send result back to client
    res.json({ text });
  } catch (error) {
    console.error('OCR processing error:', error);
    res.status(500).json({ error: 'OCR processing failed' });
  }
});

// OCR processing function using current Tesseract.js API
async function processOCR(imagePath) {
  const worker = await createWorker();
  
  // For newer versions of Tesseract.js
  await worker.load();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  
  const { data } = await worker.recognize(imagePath);
  await worker.terminate();
  
  return data.text;
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OCR server running on port ${PORT}`);
});