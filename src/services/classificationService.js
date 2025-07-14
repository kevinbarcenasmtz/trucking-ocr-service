// src/services/classificationService.js
const {logger} = require('../utils/logger');

class ClassificationService {
  /**
   * Classify receipt text into structured data
   */
  static async classifyReceipt(extractedText, correlationId) {
    try {
      logger.info({ 
        correlationId,
        textLength: extractedText.length,
        message: 'Starting receipt classification' 
      });

      // For now, use pattern matching (easily replaceable with AI later)
      const classification = await this.parseReceiptWithPatterns(extractedText, correlationId);

      // Calculate confidence based on how many fields we successfully extracted
      const confidence = this.calculateConfidence(classification);

      const result = {
        confidence,
        data: {
          ...classification,
          confidence,
        },
      };

      logger.info({ 
        correlationId,
        confidence,
        extractedFields: Object.keys(classification).filter(k => classification[k]).length,
        message: 'Receipt classification completed' 
      });

      return result;
    } catch (error) {
      logger.error({ 
        correlationId,
        error: error.message,
        message: 'Failed to classify receipt' 
      });

      // Return fallback classification
      return {
        confidence: 0.1,
        data: this.getFallbackClassification(extractedText),
      };
    }
  }

  /**
   * Parse receipt using pattern matching (replace with AI later)
   */
  static async parseReceiptWithPatterns(text, correlationId) {
    const classification = {
      date: null,
      type: 'Other',
      amount: null,
      vehicle: null,
      vendorName: null,
      location: null,
    };

    // Clean up text for better pattern matching
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const lines = cleanText.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    logger.debug({ 
      correlationId,
      linesCount: lines.length,
      message: 'Parsing receipt text' 
    });

    // Extract date
    classification.date = this.extractDate(cleanText);

    // Extract amount
    classification.amount = this.extractAmount(cleanText);

    // Extract vendor name
    classification.vendorName = this.extractVendorName(lines);

    // Determine receipt type
    classification.type = this.determineReceiptType(cleanText);

    // Extract vehicle information
    classification.vehicle = this.extractVehicle(cleanText);

    // Extract location
    classification.location = this.extractLocation(lines);

    return classification;
  }

  /**
   * Extract date from receipt text
   */
  static extractDate(text) {
    const datePatterns = [
      // MM/DD/YYYY or MM-DD-YYYY
      /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/,
      // DD/MM/YYYY or DD-MM-YYYY  
      /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/,
      // MM/DD/YY or MM-DD-YY
      /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/,
      // YYYY-MM-DD (ISO format)
      /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/,
    ];

    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          let year, month, day;
          
          if (pattern === datePatterns[3]) { // YYYY-MM-DD
            [, year, month, day] = match;
          } else if (match[3].length === 4) { // Full year
            [, month, day, year] = match;
          } else { // YY format
            [, month, day, year] = match;
            year = '20' + year; // Assume 20xx
          }

          // Ensure valid date ranges
          month = parseInt(month);
          day = parseInt(day);
          year = parseInt(year);

          if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2020 && year <= 2030) {
            return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
          }
        } catch (e) {
          continue;
        }
      }
    }

    // Fallback to today's date
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Extract amount from receipt text
   */
  static extractAmount(text) {
    const amountPatterns = [
      // $XX.XX format
      /\$\s*(\d+(?:,\d{3})*\.\d{2})/,
      // Total: $XX.XX
      /total[:\s]*\$?\s*(\d+(?:,\d{3})*\.?\d{0,2})/i,
      // Amount: XX.XX
      /amount[:\s]*\$?\s*(\d+(?:,\d{3})*\.?\d{0,2})/i,
      // Any number with decimal (as fallback)
      /(\d+\.\d{2})/,
    ];

    for (const pattern of amountPatterns) {
      const match = text.match(pattern);
      if (match) {
        let amount = match[1].replace(/,/g, '');
        const numAmount = parseFloat(amount);
        
        if (numAmount > 0 && numAmount < 10000) { // Reasonable range
          return `$${numAmount.toFixed(2)}`;
        }
      }
    }

    return '$0.00';
  }

  /**
   * Extract vendor name from receipt lines
   */
  static extractVendorName(lines) {
    if (lines.length === 0) return 'Unknown Vendor';

    // Common vendor patterns
    const knownVendors = [
      'shell', 'exxon', 'mobil', 'chevron', 'bp', 'texaco', 'valero', 'citgo',
      'speedway', 'marathon', 'sunoco', 'phillips 66', 'conoco', 'arco',
      'walmart', 'costco', 'sams club', 'target', 'home depot', 'lowes',
      'autozone', 'advance auto', 'oreilly', 'napa', 'pepboys',
    ];

    // Check first few lines for vendor name
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      const line = lines[i].toLowerCase();
      
      // Check against known vendors
      for (const vendor of knownVendors) {
        if (line.includes(vendor)) {
          return this.capitalizeWords(vendor);
        }
      }

      // If line looks like a business name (has letters and is reasonably short)
      if (lines[i].length > 2 && lines[i].length < 30 && /[a-zA-Z]/.test(lines[i])) {
        const cleaned = lines[i].replace(/[^\w\s]/g, '').trim();
        if (cleaned.length > 2) {
          return this.capitalizeWords(cleaned);
        }
      }
    }

    return 'Unknown Vendor';
  }

  /**
   * Determine receipt type based on content
   */
  static determineReceiptType(text) {
    const fuelKeywords = ['gas', 'fuel', 'diesel', 'gasoline', 'gallon', 'gal', 'unleaded', 'premium', 'pump'];
    const maintenanceKeywords = ['oil', 'tire', 'brake', 'repair', 'service', 'maintenance', 'parts', 'labor', 'inspection'];

    const lowerText = text.toLowerCase();

    // Count fuel-related keywords
    const fuelScore = fuelKeywords.reduce((score, keyword) => {
      return score + (lowerText.includes(keyword) ? 1 : 0);
    }, 0);

    // Count maintenance-related keywords  
    const maintenanceScore = maintenanceKeywords.reduce((score, keyword) => {
      return score + (lowerText.includes(keyword) ? 1 : 0);
    }, 0);

    if (fuelScore > maintenanceScore && fuelScore > 0) {
      return 'Fuel';
    } else if (maintenanceScore > 0) {
      return 'Maintenance';
    }

    return 'Other';
  }

  /**
   * Extract vehicle information
   */
  static extractVehicle(text) {
    const vehiclePatterns = [
      // Truck-XXX format
      /truck[:\s\-]*(\w+\d+|\d+)/i,
      // Vehicle XXX
      /vehicle[:\s]*(\w+\d+|\d+)/i,
      // Unit XXX
      /unit[:\s]*(\w+\d+|\d+)/i,
      // Fleet XXX
      /fleet[:\s]*(\w+\d+|\d+)/i,
      // Any pattern like XXX-XXX where X could be letter or number
      /([A-Z]{1,3}[-\s]?\d{1,4})/i,
    ];

    for (const pattern of vehiclePatterns) {
      const match = text.match(pattern);
      if (match) {
        let vehicle = match[1] || match[0];
        vehicle = vehicle.replace(/\s/g, '-').toUpperCase();
        
        if (vehicle.length >= 2 && vehicle.length <= 10) {
          return vehicle;
        }
      }
    }

    // Fallback: look for any sequence that could be a vehicle ID
    const fallbackPattern = /\b([A-Z]\d{2,4}|\d{3,4}[A-Z]?)\b/g;
    const matches = text.match(fallbackPattern);
    if (matches && matches.length > 0) {
      return matches[0];
    }

    return 'UNKNOWN';
  }

  /**
   * Extract location from receipt lines
   */
  static extractLocation(lines) {
    // Look for address-like patterns in first few lines
    for (let i = 1; i < Math.min(5, lines.length); i++) {
      const line = lines[i];
      
      // Check if line contains address indicators
      if (/\d+.*(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|ln|lane)/i.test(line)) {
        return line;
      }
      
      // Check for city, state patterns
      if (/\w+,\s*[A-Z]{2}(\s+\d{5})?/.test(line)) {
        return line;
      }
    }

    return null;
  }

  /**
   * Calculate confidence based on extracted fields
   */
  static calculateConfidence(classification) {
    let score = 0;
    const weights = {
      date: 0.2,
      amount: 0.3,
      vendorName: 0.2,
      type: 0.1,
      vehicle: 0.1,
      location: 0.1,
    };

    Object.keys(weights).forEach(field => {
      if (classification[field] && classification[field] !== 'Unknown Vendor' && classification[field] !== 'UNKNOWN') {
        score += weights[field];
      }
    });

    // Bonus for reasonable amount
    if (classification.amount && classification.amount !== '$0.00') {
      const amount = parseFloat(classification.amount.replace('$', ''));
      if (amount > 5 && amount < 1000) {
        score += 0.1;
      }
    }

    return Math.min(0.95, Math.max(0.1, score));
  }

  /**
   * Get fallback classification when parsing fails
   */
  static getFallbackClassification(text) {
    return {
      date: new Date().toISOString().split('T')[0],
      type: 'Other',
      amount: '$0.00',
      vehicle: 'UNKNOWN',
      vendorName: 'Unknown Vendor',
      location: null,
      confidence: 0.1,
    };
  }

  /**
   * Capitalize words helper
   */
  static capitalizeWords(str) {
    return str.replace(/\w\S*/g, (txt) => 
      txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
  }

  /**
   * Future method: Use AI for classification (OpenAI, Anthropic, etc.)
   */
  static async classifyWithAI(extractedText, correlationId) {
    // TODO: Implement AI classification
    // This is where you'd call OpenAI, Anthropic, or other AI services
    // For now, fallback to pattern matching
    return this.parseReceiptWithPatterns(extractedText, correlationId);
  }

  /**
   * Get classification statistics
   */
  static getStats() {
    return {
      service: 'pattern-matching',
      version: '1.0.0',
      features: ['date-extraction', 'amount-extraction', 'vendor-detection', 'type-classification'],
    };
  }
}

module.exports = ClassificationService;