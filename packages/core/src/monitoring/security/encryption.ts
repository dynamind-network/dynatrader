/**
 * Encryption Module
 *
 * Provides encryption, decryption, and key management for sensitive data
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha512';

export interface EncryptedData {
  encrypted: string;
  iv: string;
  tag: string;
  salt?: string;
  algorithm: string;
  version: number;
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
  createdAt: number;
}

export interface EncryptionConfig {
  masterKey?: string;
  keyRotationDays?: number;
  algorithm?: string;
}

export class EncryptionService {
  private masterKey: Buffer;
  private keyCreatedAt: number;
  private keyRotationDays: number;
  private keyPairs: Map<string, KeyPair> = new Map();

  constructor(config: EncryptionConfig = {}) {
    this.masterKey = config.masterKey
      ? Buffer.from(config.masterKey, 'hex')
      : crypto.randomBytes(KEY_LENGTH);
    this.keyCreatedAt = Date.now();
    this.keyRotationDays = config.keyRotationDays || 90;
  }

  /**
   * Encrypt sensitive data
   */
  encrypt(plaintext: string): EncryptedData {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = this.deriveKey(salt);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');

    return {
      encrypted,
      iv: iv.toString('hex'),
      tag,
      salt: salt.toString('hex'),
      algorithm: ALGORITHM,
      version: 1,
    };
  }

  /**
   * Decrypt encrypted data
   */
  decrypt(data: EncryptedData): string {
    const salt = data.salt ? Buffer.from(data.salt, 'hex') : null;
    const key = salt ? this.deriveKey(salt) : this.masterKey;
    const iv = Buffer.from(data.iv, 'hex');
    const tag = Buffer.from(data.tag, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    decipher.setAuthTag(tag);

    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Hash sensitive data (one-way)
   */
  hash(data: string): string {
    const salt = crypto.randomBytes(SALT_LENGTH);
    return crypto.pbkdf2Sync(data, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST).toString('hex');
  }

  /**
   * Verify hashed data
   */
  verifyHash(data: string, hash: string): boolean {
    // For simplicity, we compare using constant-time comparison
    const computedHash = crypto.pbkdf2Sync(
      data,
      hash.slice(0, SALT_LENGTH * 2),
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    ).toString('hex');

    return crypto.timingSafeEqual(
      Buffer.from(computedHash),
      Buffer.from(hash)
    );
  }

  /**
   * Generate RSA key pair for asymmetric encryption
   */
  generateKeyPair(): KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    const keyPair: KeyPair = {
      publicKey,
      privateKey,
      createdAt: Date.now(),
    };

    const keyId = crypto.randomBytes(16).toString('hex');
    this.keyPairs.set(keyId, keyPair);

    return keyPair;
  }

  /**
   * Sign data with private key
   */
  sign(data: string, privateKey: string): string {
    const sign = crypto.createSign('sha512');
    sign.update(data);
    sign.end();
    return sign.sign(privateKey, 'hex');
  }

  /**
   * Verify signature with public key
   */
  verify(data: string, signature: string, publicKey: string): boolean {
    const verify = crypto.createVerify('sha512');
    verify.update(data);
    verify.end();
    return verify.verify(publicKey, signature, 'hex');
  }

  /**
   * Rotate encryption key
   */
  rotateKey(): void {
    this.masterKey = crypto.randomBytes(KEY_LENGTH);
    this.keyCreatedAt = Date.now();
  }

  /**
   * Check if key rotation is needed
   */
  needsRotation(): boolean {
    const daysSinceCreation = (Date.now() - this.keyCreatedAt) / (1000 * 60 * 60 * 24);
    return daysSinceCreation >= this.keyRotationDays;
  }

  /**
   * Derive encryption key from master key and salt
   */
  private deriveKey(salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(
      this.masterKey,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    );
  }
}