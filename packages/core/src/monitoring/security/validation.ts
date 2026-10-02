/**
 * Input Validation Module
 *
 * Provides comprehensive input validation and sanitization for all API inputs
 */

import { z } from 'zod';

export interface ValidationRule {
  field: string;
  rules: (z.ZodType | ((value: any) => boolean))[];
  message?: string;
}

export interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

export type SchemaKey =
  | 'userCreate'
  | 'sessionCreate'
  | 'orderCreate'
  | 'strategyCreate'
  | 'policyCreate'
  | 'wsMessage'
  | 'apiKey';

export class Validator {
  private schemas = {
    // User validation
    userCreate: z.object({
      username: z.string()
        .min(3, 'Username must be at least 3 characters')
        .max(32, 'Username must be no more than 32 characters')
        .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
      email: z.string().email('Invalid email address'),
      password: z.string()
        .min(8, 'Password must be at least 8 characters')
        .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
        .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
        .regex(/[0-9]/, 'Password must contain at least one number')
        .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
      role: z.enum(['user', 'operator', 'admin']),
      permissions: z.array(z.string()).optional(),
    }),

    // Session validation
    sessionCreate: z.object({
      userId: z.string(),
      accountId: z.string(),
      permissions: z.array(z.string()),
      riskLevel: z.enum(['low', 'medium', 'high']),
      deviceType: z.enum(['desktop', 'mobile', 'api']),
    }),

    // Order validation
    orderCreate: z.object({
      symbol: z.string()
        .regex(/^[A-Z]{2,10}\/[A-Z]{2,10}$/, 'Symbol must be in format BASE/QUOTE'),
      side: z.enum(['buy', 'sell']),
      type: z.enum(['market', 'limit', 'stop', 'stop_limit']),
      quantity: z.number()
        .positive('Quantity must be positive')
        .finite('Quantity must be finite'),
      price: z.number()
        .positive('Price must be positive')
        .finite('Price must be finite')
        .optional(),
      timeInForce: z.enum(['GTC', 'IOC', 'FOK']).default('GTC'),
      leverage: z.number()
        .min(1, 'Leverage must be at least 1x')
        .max(100, 'Leverage must be no more than 100x')
        .default(1),
      metadata: z.record(z.any()).optional(),
    }).refine(data => {
      if (data.type === 'limit' && !data.price) {
        return false;
      }
      if (data.type === 'stop_limit' && !data.price) {
        return false;
      }
      return true;
    }, { message: 'Price is required for limit and stop_limit orders' }),

    // Strategy validation
    strategyCreate: z.object({
      name: z.string()
        .min(1, 'Strategy name is required')
        .max(64, 'Strategy name must be no more than 64 characters'),
      description: z.string().max(512, 'Description must be no more than 512 characters'),
      venue: z.string().min(1, 'Venue is required'),
      symbol: z.string().min(1, 'Symbol is required'),
      timeframe: z.string().optional(),
      entry: z.record(z.any(), {
        message: 'Entry rules must be an object',
      }).optional(),
      exits: z.record(z.any(), {
        message: 'Exit rules must be an object',
      }).optional(),
      sizing: z.record(z.any(), {
        message: 'Sizing rules must be an object',
      }).optional(),
      risk: z.object({
        maxPositionNotional: z.number().positive('Max position must be positive'),
        maxDailyLoss: z.number().positive('Max daily loss must be positive'),
        maxOpenOrders: z.number().int('Max open orders must be an integer').positive(),
      }),
      executionMode: z.enum(['paper', 'live']),
    }),

    // Risk policy validation
    policyCreate: z.object({
      name: z.string()
        .min(1, 'Policy name is required')
        .max(64, 'Policy name must be no more than 64 characters'),
      description: z.string().max(512, 'Description must be no more than 512 characters'),
      version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must be in format x.y.z'),
      active: z.boolean(),
      rules: z.array(z.object({
        id: z.string(),
        type: z.enum(['threshold', 'limit', 'time_based', 'complex']),
        condition: z.string(),
        action: z.enum(['alert', 'block', 'modify', 'escalate']),
        params: z.record(z.any()),
      })),
    }),

    // WebSocket message validation
    wsMessage: z.object({
      type: z.string(),
      channel: z.string().optional(),
      payload: z.record(z.any()).optional(),
      timestamp: z.number().optional(),
      signature: z.string().optional(),
    }),

    // API key validation
    apiKey: z.object({
      name: z.string().min(1, 'API key name is required'),
      permissions: z.array(z.string()).default([]),
      ipWhitelist: z.array(z.string().ip({
        message: 'Invalid IP address in whitelist',
      })).default([]),
      rateLimit: z.number()
        .min(1, 'Rate limit must be positive')
        .default(1000),
      expiresAt: z.number().optional(),
    }),
  };

  /**
   * Validate input against schema
   */
  validate<T>(schemaKey: keyof typeof this.schemas, data: any): { success: true; data: T } | { success: false; errors: ValidationError[] } {
    const schema = this.schemas[schemaKey];

    if (!schema) {
      return {
        success: false,
        errors: [{ field: 'schema', message: `Unknown schema: ${schemaKey}` }],
      };
    }

    try {
      const validated = schema.parse(data);
      return { success: true, data: validated as T };
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors: ValidationError[] = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
        }));
        return { success: false, errors };
      }
      throw error;
    }
  }

  /**
   * Sanitize input to prevent injection attacks
   */
  sanitizeInput(input: any): any {
    if (typeof input !== 'object' || input === null) {
      return input;
    }

    if (Array.isArray(input)) {
      return input.map(item => this.sanitizeInput(item));
    }

    const sanitized: any = {};

    for (const [key, value] of Object.entries(input)) {
      // Sanitize key
      const safeKey = this.sanitizeKey(key);

      // Sanitize value
      if (typeof value === 'string') {
        sanitized[safeKey] = this.sanitizeString(value);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[safeKey] = this.sanitizeInput(value);
      } else {
        sanitized[safeKey] = value;
      }
    }

    return sanitized;
  }

  /**
   * Validate numeric ranges for trading parameters
   */
  validateTradingParams(params: {
    maxLeverage?: number;
    maxPositionSize?: number;
    dailyLossLimit?: number;
    symbol?: string;
  }): ValidationError[] {
    const errors: ValidationError[] = [];

    if (params.maxLeverage && (params.maxLeverage < 1 || params.maxLeverage > 100)) {
      errors.push({
        field: 'maxLeverage',
        message: 'Max leverage must be between 1 and 100',
      });
    }

    if (params.maxPositionSize && params.maxPositionSize <= 0) {
      errors.push({
        field: 'maxPositionSize',
        message: 'Max position size must be positive',
      });
    }

    if (params.dailyLossLimit && params.dailyLossLimit > 0) {
      // Check if limit is reasonable (not more than 10% of account)
      if (params.dailyLossLimit > 1000000) { // $1M default limit
        errors.push({
          field: 'dailyLossLimit',
          message: 'Daily loss limit seems unusually high',
        });
      }
    }

    if (params.symbol) {
      const symbolRegex = /^[A-Z]{2,10}\/[A-Z]{2,10}$/;
      if (!symbolRegex.test(params.symbol)) {
        errors.push({
          field: 'symbol',
          message: 'Symbol must be in format BASE/QUOTE (for example, ASSET/QUOTE)',
        });
      }
    }

    return errors;
  }

  /**
   * Check for malicious patterns in input
   */
  checkMaliciousPatterns(input: string): { isMalicious: boolean; patterns: string[] } {
    const maliciousPatterns = [
      /<script[^>]*>.*?<\/script>/gis, // Script tags
      /javascript:/gi, // Javascript protocol
      /on\w+\s*=/gi, // Event handlers
      /<iframe[^>]*>.*?<\/iframe>/gis, // Iframes
      /<object[^>]*>.*?<\/object>/gis, // Objects
      /<embed[^>]*>.*?<\/embed>/gis, // Embeds
      /data:text\/html/i, // Data URIs
      /\b(alert|confirm|prompt)\s*\(/gi, // Alert functions
      /document\./gi, // Document access
      /window\./gi, // Window access
      /\.\.\./g, // Path traversal
      /\/\.\.\/\.\.\//g, // Directory traversal
      /union\s+select/gi, // SQL injection
      /drop\s+table/gi, // SQL injection
      /exec\s*\(/gi, // Command injection
      /system\s*\(/gi, // Command injection
    ];

    const matches = maliciousPatterns.filter(pattern => pattern.test(input));
    return {
      isMalicious: matches.length > 0,
      patterns: matches.map(p => p.toString()),
    };
  }

  /**
   * Validate file upload
   */
  validateFile(file: {
    name: string;
    size: number;
    type: string;
    mimetype?: string;
  }): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    const maxSize = 10 * 1024 * 1024; // 10MB
    const allowedTypes = [
      'application/json',
      'text/plain',
      'application/xml',
      'text/xml',
    ];

    // Check size
    if (file.size > maxSize) {
      errors.push('File size must be less than 10MB');
    }

    // Check type
    if (!allowedTypes.includes(file.type)) {
      errors.push(`File type ${file.type} is not allowed`);
    }

    // Check filename
    if (!file.name || file.name.length > 255) {
      errors.push('Filename must be between 1 and 255 characters');
    }

    // Check for dangerous extensions
    const dangerousExts = ['.exe', '.bat', '.cmd', '.sh', '.php', '.js', '.html', '.htm'];
    const ext = file.name.toLowerCase().split('.').pop();
    if (dangerousExts.includes(`.${ext}`)) {
      errors.push('File extension is not allowed');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Sanitize string to prevent XSS
   */
  private sanitizeString(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Sanitize object key to prevent prototype pollution
   */
  private sanitizeKey(key: string): string {
    // Block prototype pollution keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return '_invalid_key';
    }

    // Remove any characters that could be problematic
    return key.replace(/[^\w\s\-]/g, '');
  }
}
