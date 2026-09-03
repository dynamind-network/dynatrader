/**
 * Input validation utilities to prevent common security vulnerabilities
 */

/**
 * Extract error message from unknown error type
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function validateAddress(address: unknown): address is string {
  if (typeof address !== 'string') return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  return true;
}

function validatePrivateKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const cleanKey = key.startsWith('0x') ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(cleanKey)) return false;
  return true;
}

function validateAmount(amount: unknown, allowZero = false): amount is number {
  if (typeof amount !== 'number') return false;
  if (!Number.isFinite(amount)) return false;
  if (amount < 0) return false;
  if (!allowZero && amount === 0) return false;
  return true;
}

function validatePositiveInt(value: unknown): value is number {
  if (!Number.isInteger(value)) return false;
  if (typeof value !== 'number') return false;
  return value > 0;
}

function validateDecimals(value: number, maxDecimals: number): boolean {
  const str = String(value);
  const parts = str.split('.');
  if (parts.length === 1) return true;
  return parts[1].length <= maxDecimals;
}

function validatePercentage(percent: unknown): percent is number {
  if (typeof percent !== 'number') return false;
  if (!Number.isFinite(percent)) return false;
  return percent >= 0 && percent <= 100;
}

function validateRpcUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateApiKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (key.length === 0) return false;
  if (key.length > 500) return false;
  return true;
}

function validateSymbol(symbol: unknown): symbol is string {
  if (typeof symbol !== 'string') return false;
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return false;
  return true;
}

function validateChain(chain: unknown, supportedChains: string[]): chain is string {
  if (typeof chain !== 'string') return false;
  return supportedChains.includes(chain.toLowerCase());
}

function sanitizeErrorMessage(error: Error): string {
  const message = error.message;

  const cleaned = message
    .replace(/0x[0-9a-f]{64}/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/sk-[a-zA-Z0-9-]+/g, '[REDACTED_API_KEY]')
    .replace(/Bearer [a-zA-Z0-9-_.]+/g, '[REDACTED_TOKEN]');

  return cleaned;
}

function sanitizeAddress(address: unknown): string {
  if (typeof address !== 'string') {
    throw new ValidationError('Address must be a string');
  }

  const trimmed = address.trim();
  if (!validateAddress(trimmed)) {
    throw new ValidationError('Invalid Ethereum address format');
  }

  return trimmed.toLowerCase();
}

function sanitizeAmount(amount: unknown, name = 'amount'): number {
  if (typeof amount === 'string') {
    const parsed = parseFloat(amount);
    if (isNaN(parsed)) {
      throw new ValidationError(`${name} must be a valid number`);
    }
    amount = parsed;
  }

  if (!validateAmount(amount, true)) {
    throw new ValidationError(`${name} must be a positive number`);
  }

  return amount;
}

function validateCalculation(result: number, operation: string): number {
  if (!Number.isFinite(result)) {
    throw new ValidationError(`${operation} resulted in invalid number: ${result}`);
  }
  return result;
}

function validateAddressArray(addresses: unknown): string[] {
  if (!Array.isArray(addresses)) {
    throw new ValidationError('Addresses must be an array');
  }

  return addresses.map((addr, idx) => {
    if (!validateAddress(addr)) {
      throw new ValidationError(`Invalid address at index ${idx}`);
    }
    return (addr as string).toLowerCase();
  });
}

function validateExchangeRate(rate: unknown): number {
  if (!validateAmount(rate)) {
    throw new ValidationError('Exchange rate must be a positive number');
  }
  return rate;
}

function validateLeverage(leverage: unknown, maxLeverage = 125): number {
  if (!validateAmount(leverage)) {
    throw new ValidationError('Leverage must be a positive number');
  }
  if (leverage > maxLeverage) {
    throw new ValidationError(`Leverage cannot exceed ${maxLeverage}x`);
  }
  return leverage;
}

export const Validation = {
  validateAddress,
  validatePrivateKey,
  validateAmount,
  validatePositiveInt,
  validateDecimals,
  validatePercentage,
  validateRpcUrl,
  validateApiKey,
  validateSymbol,
  validateChain,
  sanitizeErrorMessage,
  sanitizeAddress,
  sanitizeAmount,
  validateCalculation,
  validateAddressArray,
  validateExchangeRate,
  validateLeverage,
};
