/**
 * Authentication and Authorization Module
 *
 * Handles JWT-based authentication, role-based access control, and session management
 */

import jwt from 'jsonwebtoken';
import type { StringValue } from 'ms';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import Emittery from 'emittery';
import { MemoryStoreImpl } from '@dyna/memory-core';

export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  claims: UserClaims;
}

export interface UserClaims {
  sub: string; // user ID
  username: string;
  role: string;
  permissions: string[];
  accountId?: string;
  iat: number;
  exp: number;
}

export interface Permission {
  resource: string;
  action: string;
  conditions?: Record<string, any>;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiration: string;
  jwtRefreshExpiration: string;
  bcryptRounds: number;
  sessionTimeout: number;
  maxLoginAttempts: number;
}

export class AuthService extends Emittery<Record<string, unknown>> {
  private config: AuthConfig;
  private memory: MemoryStoreImpl;
  private activeSessions = new Map<string, { userId: string; expiresAt: number }>();

  constructor(config: AuthConfig, memory: MemoryStoreImpl) {
    super();
    this.config = config;
    this.memory = memory;
  }

  /**
   * Authenticate user with credentials
   */
  async authenticate(username: string, password: string, ipAddress: string): Promise<AuthToken> {
    // Check if user is temporarily locked
    const lockout = await this.isAccountLocked(username);
    if (lockout) {
      throw new Error('Account temporarily locked due to multiple failed attempts');
    }

    // Get user from database
    const user = await this.memory.getUser(username);
    if (!user) {
      await this.recordFailedLogin(username, ipAddress);
      throw new Error('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.hashedPassword);
    if (!isPasswordValid) {
      await this.recordFailedLogin(username, ipAddress);
      throw new Error('Invalid credentials');
    }

    // Reset failed attempts on successful login
    await this.resetFailedAttempts(username);

    // Create tokens
    const claims: UserClaims = {
      sub: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions || [],
      accountId: user.accountId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.parseJwtExpiration(this.config.jwtExpiration),
    };

    // jwtExpiration is typed as `string` in AuthConfig but jwt.sign expects `StringValue | number`.
    // The runtime values are always valid ms-format strings (e.g. "1h", "7d"), so this cast is safe.
    const accessToken = jwt.sign(claims as object, this.config.jwtSecret, { expiresIn: this.config.jwtExpiration as StringValue });
    const refreshToken = jwt.sign({ sub: user.id } as object, this.config.jwtSecret, { expiresIn: this.config.jwtRefreshExpiration as StringValue });

    // Store session
    const sessionId = await this.createSession(user.id, ipAddress);
    this.activeSessions.set(sessionId, {
      userId: user.id,
      expiresAt: Date.now() + this.config.sessionTimeout,
    });

    // Emit auth event
    this.emit('user_authenticated', { userId: user.id, sessionId, ipAddress });

    return {
      accessToken,
      refreshToken,
      expiresAt: claims.exp * 1000,
      claims,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshToken: string): Promise<{ accessToken: string; claims: UserClaims }> {
    try {
      const decoded = jwt.verify(refreshToken, this.config.jwtSecret, { algorithms: ['HS256'] }) as { sub: string };

      // Validate session exists
      const sessionId = await this.findSessionByUserId(decoded.sub);
      if (!sessionId) {
        throw new Error('Invalid refresh token');
      }

      // Create new token
      const user = await this.memory.getUserById(decoded.sub);
      if (!user) {
        throw new Error('User not found');
      }

      const claims: UserClaims = {
        sub: user.id,
        username: user.username,
        role: user.role,
        permissions: user.permissions || [],
        accountId: user.accountId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + this.parseJwtExpiration(this.config.jwtExpiration),
      };

      const accessToken = jwt.sign(claims as object, this.config.jwtSecret, { expiresIn: this.config.jwtExpiration as StringValue });

      // Update session
      this.activeSessions.set(sessionId, {
        userId: user.id,
        expiresAt: Date.now() + this.config.sessionTimeout,
      });

      return {
        accessToken,
        claims,
      };
    } catch (error) {
      throw new Error('Invalid refresh token');
    }
  }

  /**
   * Validate JWT token and extract claims
   */
  validateToken(token: string): UserClaims {
    try {
      return jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'] }) as UserClaims;
    } catch (error) {
      throw new Error('Invalid token');
    }
  }

  /**
   * Check if user has required permission
   */
  async hasPermission(claims: UserClaims, resource: string, action: string, context?: any): Promise<boolean> {
    if (claims.role === 'admin') return true;

    const hasDirectPermission = claims.permissions.some(permission => {
      if (permission === '*') return true;
      if (permission === `${resource}:${action}`) return true;
      return false;
    });

    if (!hasDirectPermission) return false;

    // Check conditional permissions
    const userPermissions = (await this.memory.getUserPermissions(claims.sub)) as Array<{ resource: string; action: string; conditions?: unknown }>;
    const permission = userPermissions.find((p: { resource: string; action: string; conditions?: unknown }) =>
      p.resource === resource && p.action === action
    );

    if (!permission?.conditions) return true;

    // Evaluate conditions
    return this.evaluateConditions(permission.conditions, claims, context);
  }

  /**
   * Logout and invalidate session
   */
  async logout(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    await this.deleteSession(sessionId);
    this.emit('user_logged_out', { sessionId });
  }

  /**
   * Check if account is locked due to failed attempts
   */
  private async isAccountLocked(username: string): Promise<boolean> {
    const attempts = await this.memory.getLoginAttempts(username);
    if (attempts && attempts.count >= this.config.maxLoginAttempts) {
      const lockUntil = attempts.lockUntil;
      if (lockUntil && lockUntil > Date.now()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Record failed login attempt
   */
  private async recordFailedLogin(username: string, ipAddress: string): Promise<void> {
    const attempts = await this.memory.getLoginAttempts(username) || { count: 0, lastAttempt: Date.now() };

    const newCount = attempts.count + 1;
    let lockUntil = null;

    if (newCount >= this.config.maxLoginAttempts) {
      lockUntil = Date.now() + 30 * 60 * 1000; // 30 minutes lockout
    }

    await this.memory.setLoginAttempts(username, {
      count: newCount,
      lastAttempt: Date.now(),
      lockUntil,
    });
  }

  /**
   * Reset failed login attempts
   */
  private async resetFailedAttempts(username: string): Promise<void> {
    await this.memory.setLoginAttempts(username, { count: 0, lastAttempt: Date.now(), lockUntil: null });
  }

  /**
   * Create new session
   */
  private async createSession(userId: string, ipAddress: string): Promise<string> {
    const sessionId = `session_${Date.now()}_${randomUUID()}`;

    await this.memory.setSession({
      id: sessionId,
      userId,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      ipAddress,
      userAgent: '', // Would be captured from HTTP request
    });

    return sessionId;
  }

  /**
   * Find active session by user ID
   */
  private async findSessionByUserId(userId: string): Promise<string | null> {
    const sessions = (await this.memory.getUserSessions(userId)) as Array<{ id: string; userId: string }>;
    const activeSession = sessions.find((s: { id: string; userId: string }) =>
      this.activeSessions.has(s.id) &&
      this.activeSessions.get(s.id)!.userId === userId
    );

    return activeSession?.id || null;
  }

  /**
   * Delete session
   */
  private async deleteSession(sessionId: string): Promise<void> {
    await this.memory.deleteSession(sessionId);
  }

  /**
   * Parse JWT expiration string to seconds
   */
  private parseJwtExpiration(expiration: string): number {
    const unit = expiration.slice(-1);
    const value = parseInt(expiration.slice(0, -1));

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: return value;
    }
  }

  /**
   * Evaluate conditional permissions
   */
  private evaluateConditions(
    conditions: Record<string, any>,
    claims: UserClaims,
    context?: any
  ): boolean {
    // Simple condition evaluator - can be enhanced with expression evaluation
    for (const [key, value] of Object.entries(conditions)) {
      if (key.startsWith('user.')) {
        const claimKey = key.slice(5);
        if (claims[claimKey as keyof UserClaims] !== value) return false;
      } else if (context && context[key] !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if a session is active
   */
  async hasActiveSession(sessionId: string): Promise<boolean> {
    return this.activeSessions.has(sessionId) || await this.memory.hasActiveSession(sessionId);
  }

  /**
   * Validate an API key and return associated data
   */
  async validateApiKey(apiKey: string): Promise<{ userId: string; name: string; role: string; permissions: string[] } | null> {
    return this.memory.validateApiKey(apiKey);
  }
}