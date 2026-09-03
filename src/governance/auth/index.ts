import { z } from 'zod';
import { Logger } from '@dyna/audit';

// Auth schema
const AuthSchema = z.object({
  version: z.string(),
  owner: z.object({
    id: z.string(),
    role: z.enum(['owner', 'operator'])
  }),
  channels: z.record(z.object({
    enabled: z.boolean(),
    allowed_users: z.array(z.string())
  })),
  roles: z.record(z.object({
    permissions: z.array(z.string())
  })),
  approval_required_for: z.array(z.string()),
  blocked_operations: z.array(z.string())
});

export interface AuthConfig {
  version: string;
  owner: {
    id: string;
    role: string;
  };
  channels: {
    [key: string]: {
      enabled: boolean;
      allowed_users: string[];
    };
  };
  roles: {
    [key: string]: {
      permissions: string[];
    };
  };
  approval_required_for: string[];
  blocked_operations: string[];
}

export class AuthRuntime {
  private config: AuthConfig;
  private logger = new Logger('AuthRuntime');

  constructor(config: any) {
    const result = AuthSchema.safeParse(config);
    if (!result.success) {
      throw new Error(`Invalid auth configuration: ${result.error.message}`);
    }
    this.config = result.data;
    this.logger.info('Auth runtime initialized');
  }

  // Check if a user has access to a channel
  canAccessChannel(userId: string, channel: string): boolean {
    if (!this.config.channels[channel]) {
      return false;
    }

    const channelConfig = this.config.channels[channel];
    if (!channelConfig.enabled) {
      return false;
    }

    return channelConfig.allowed_users.includes(userId);
  }

  // Get user permissions
  getUserPermissions(userId: string): string[] {
    const userRole = this.getUserRole(userId);
    if (!userRole) {
      return [];
    }

    return this.config.roles[userRole]?.permissions || [];
  }

  // Check if user has a specific permission
  hasPermission(userId: string, permission: string): boolean {
    const userPermissions = this.getUserPermissions(userId);
    return userPermissions.includes('*') || userPermissions.includes(permission);
  }

  // Check if operation requires approval
  requiresApproval(operation: string): boolean {
    return this.config.approval_required_for.includes(operation);
  }

  // Check if operation is blocked
  isBlocked(operation: string): boolean {
    return this.config.blocked_operations.includes(operation);
  }

  // Get user role
  private getUserRole(userId: string): string | null {
    if (this.config.owner.id === userId) {
      return this.config.owner.role;
    }

    // Check channels to infer role
    for (const [channel, config] of Object.entries(this.config.channels)) {
      if (config.allowed_users.includes(userId)) {
        return 'operator'; // Default role for non-owner users
      }
    }

    return null;
  }

  // Validate auth configuration
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check required fields
    if (!this.config.version) errors.push('version is required');
    if (!this.config.owner) errors.push('owner is required');
    if (!this.config.channels) errors.push('channels is required');
    if (!this.config.roles) errors.push('roles is required');

    // Validate owner role
    if (!['owner', 'operator'].includes(this.config.owner.role)) {
      errors.push('owner.role must be either "owner" or "operator"');
    }

    // Validate channel configurations
    Object.entries(this.config.channels).forEach(([channelName, config]) => {
      if (typeof config.enabled !== 'boolean') {
        errors.push(`channel ${channelName}: enabled must be boolean`);
      }
      if (!Array.isArray(config.allowed_users)) {
        errors.push(`channel ${channelName}: allowed_users must be array`);
      }
    });

    // Validate role configurations
    Object.entries(this.config.roles).forEach(([roleName, config]) => {
      if (!Array.isArray(config.permissions)) {
        errors.push(`role ${roleName}: permissions must be array`);
      }
    });

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export { AuthSchema };