# Trucking Logistics OCR Service

A backend service for Optical Character Recognition (OCR) processing for the Trucking Logistics Pro mobile application.

## Overview

This service provides an API endpoint that processes images containing text (such as receipts, invoices, and documents) and returns the extracted text. It's built with Node.js, Express, and Tesseract.js, and is designed to be used with the Trucking Logistics Pro mobile app.

## Features

- Image processing using Tesseract.js OCR engine
- REST API for text extraction from images
- Support for base64-encoded image uploads
- Error handling and validation
- CORS enabled for cross-origin requests

## API Endpoints

### OCR Processing

**Endpoint:** `POST /api/ocr/base64`

**Request Body:**
```json
{
  "image": "data:image/jpeg;base64,<base64-encoded-image-data>"
}
```

**Response:**
```json
{
  "text": "Extracted text from the image"
}
```

**Error Response:**
```json
{
  "error": "Error message"
}
```

## Local Development

### Prerequisites

- Node.js (v14 or newer)
- npm or yarn

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/trucking-ocr-service.git
cd trucking-ocr-service
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm start
```

The server will be running at http://localhost:3000.

### Environment Variables

- `PORT`: Port number for the server (default: 3000)

## Deployment

This service is deployed on Heroku. To deploy your own instance:

1. Create a Heroku app:
```bash
heroku create your-app-name
```

2. Deploy to Heroku:
```bash
git push heroku main
```

## Integration with Mobile App

The service is designed to be used with the Trucking Logistics Pro mobile app. The mobile app sends images to this service for OCR processing.

### Mobile App Integration Code

```typescript
// OcrService.ts in React Native app
import * as FileSystem from 'expo-file-system';

const API_URL = 'https://your-heroku-app.herokuapp.com/api/ocr/base64';

export class OcrService {
  static async recognizeText(imageUri: string): Promise<string> {
    try {
      // Convert image to base64
      const base64 = await FileSystem.readAsStringAsync(imageUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      
      // Format for sending to server
      const imageData = `data:image/jpeg;base64,${base64}`;

      // Send to backend
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: imageData,
        }),
      });

      if (!response.ok) {
        throw new Error(`OCR service error: ${response.status}`);
      }

      const result = await response.json();
      return result.text;
    } catch (error) {
      console.error('Error in OCR processing:', error);
      throw error;
    }
  }
}
```

## Technology Stack

- **Server**: Node.js, Express
- **OCR Engine**: Tesseract.js
- **Deployment**: Heroku

## License

MIT

## Contact

For questions or support, please contact [your-email@example.com](mailto:your-email@example.com).
