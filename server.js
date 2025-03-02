const express = require('express');
const { createWorker } = require('tesseract.js');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// Set up Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Set up storage for uploaded files
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

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
    
    // Save base64 image to file system temporarily
    const imagePath = path.join(uploadDir, `${Date.now()}.jpg`);
    const imageBuffer = Buffer.from(image.split(',')[1], 'base64');
    fs.writeFileSync(imagePath, imageBuffer);
    
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

// Handle file uploads
app.post('/api/ocr/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Process with OCR
    const text = await processOCR(req.file.path);
    
    // Clean up temp file
    fs.unlinkSync(req.file.path);
    
    // Send result back to client
    res.json({ text });
  } catch (error) {
    console.error('OCR processing error:', error);
    res.status(500).json({ error: 'OCR processing failed' });
  }
});

// OCR processing function
async function processOCR(imagePath) {
  const worker = await createWorker();
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