const express = require('express');
const { createWorker } = require('tesseract.js');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// set up Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// add a simple home route
app.get('/', (req, res) => {
  res.send('OCR Service is running. Send POST requests to /api/ocr/base64');
});

// handle the base64 image uploads
app.post('/api/ocr/base64', async (req, res) => {
  try {
    const { image } = req.body;
    
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }
    
    // ensure uploads directory exists
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    
    // extract base64 data - handle different possible formats
    let base64Data = image;
    if (image.includes(',')) {
      base64Data = image.split(',')[1];
    }
    
    // save base64 image to file system temporarily
    const imagePath = path.join(uploadDir, `${Date.now()}.jpg`);
    fs.writeFileSync(imagePath, Buffer.from(base64Data, 'base64'));
    
    // process with OCR
    const text = await processOCR(imagePath);
    
    // clean up temp file
    fs.unlinkSync(imagePath);
    
    // send result back to client
    res.json({ text });
  } catch (error) {
    console.error('OCR processing error:', error);
    res.status(500).json({ error: 'OCR processing failed' });
  }
});

// ocr processing function using Tesseract.js v4 API
async function processOCR(imagePath) {
  // createWorker is now async in v4
  const worker = await createWorker('eng');
  
  // in v4, recognize directly without loading or initializing
  const { data } = await worker.recognize(imagePath);
  
  // always terminate to free resources
  await worker.terminate();
  
  return data.text;
}

// ai classification endpoint
app.post('/api/classify-receipt', async (req, res) => {
  try {
    const { extractedText } = req.body;
    
    if (!extractedText || extractedText.length < 10) {
      return res.status(400).json({ 
        error: 'Text too short for classification',
        classification: fallbackClassification(extractedText)
      });
    }

    // make the Anthropic API call
    const message = await anthropic.messages.create({
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 1000,
      system: 'You are an expert at analyzing receipt data. Extract the structured information from the provided receipt text.',
      messages: [
        {
          role: 'user',
          content: `Analyze this receipt text and extract the following information:
            - date: The receipt date in YYYY-MM-DD format
            - type: Either "Fuel", "Material Transportation", or "Other"
            - amount: The total amount paid
            - vehicle: Any vehicle identification
            - vendorName: The name of the business
            - location: The address if available
            
            Format your response as valid JSON with these exact field names.
            
            Raw receipt text:
            ${extractedText}`,
        },
      ],
    });

    // Extract JSON from response
    let textContent = '';
    if (message.content && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          textContent += block.text;
        }
      }
    }

    // Parse JSON from response
    const jsonMatch =
      textContent.match(/```json\s*([\s\S]*?)\s*```/) ||
      textContent.match(/```\s*([\s\S]*?)\s*```/) ||
      textContent.match(/{[\s\S]*?}/);

    const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : textContent;
    const classification = JSON.parse(jsonStr.trim());

    res.json({ classification });
  } catch (error) {
    console.error('AI Classification error:', error);
    res.status(500).json({ 
      error: 'Classification failed',
      classification: fallbackClassification(req.body.extractedText || '')
    });
  }
});

// fallback classification function
function fallbackClassification(text) {
  const upperText = text.toUpperCase();
  
  // determine type
  let type = 'Other';
  if (upperText.includes('FUEL') || upperText.includes('GAS') || 
      upperText.includes('DIESEL') || upperText.includes('PETROL')) {
    type = 'Fuel';
  } else if (upperText.includes('TRANSPORT') || upperText.includes('FREIGHT') || 
             upperText.includes('LOGISTICS') || upperText.includes('SHIPPING')) {
    type = 'Material Transportation';
  }

  // extract amount (look for patterns like $XX.XX or XX.XX)
  const amountMatch = text.match(/\$?(\d+\.?\d*)/);
  const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

  // extract date
  const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  const date = dateMatch ? formatDate(dateMatch[1]) : new Date().toISOString().split('T')[0];

  return {
    date,
    type,
    amount,
    vehicle: '',
    vendorName: extractVendorName(text),
    location: extractLocation(text),
  };
}

function formatDate(dateStr) {
  // convert various date formats to YYYY-MM-DD
  const parts = dateStr.split(/[\/\-]/);
  if (parts.length === 3) {
    const [month, day, year] = parts;
    const fullYear = year.length === 2 ? `20${year}` : year;
    return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return new Date().toISOString().split('T')[0];
}

function extractVendorName(text) {
  const lines = text.split('\n').filter(line => line.trim());
  return lines[0] || 'Unknown Vendor';
}

function extractLocation(text) {
  const addressPatterns = [
    /\d+\s+[\w\s]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct)/i,
    /\b\d{5}\b/, // ZIP code
  ];
  
  for (const pattern of addressPatterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  
  return '';
}

// start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OCR server running on port ${PORT}`);
});