export { createPrismaClient, getPrismaClient } from './client.js';
export type { PrismaClient } from './client.js';

export {
  PERMISSIONS,
  ALL_PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
  type RoleSeed,
} from './permissions.js';

export {
  PERMISSION_CATALOGUE,
  PERMISSION_CATEGORIES,
  SYSTEM_ROLE_KEYS,
  LOCKED_ROLE_KEY,
  defaultPermissionsFor,
  type PermissionCategory,
  type PermissionInfo,
} from './permission-catalogue.js';

export { withTenant, forEachTenant, InvalidTenantIdError } from './tenancy.js';
export type { TenantClient } from './tenancy.js';

export * from './generated/prisma/enums.js';
export type * from './generated/prisma/models.js';
