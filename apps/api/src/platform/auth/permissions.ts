/**
 * Re-export of the shared permission vocabulary.
 *
 * The definition lives in `@healthcloud/db` because both the API and the seed
 * scripts need it, and keeping two copies in step failed the first time it was
 * tested: appointment permissions were added here but not to the seed, and every
 * scheduling endpoint returned 403 against a database whose roles had never
 * heard of them.
 *
 * Import from here in API code; the indirection keeps call sites short and means
 * the source can move again without touching every controller.
 */
export {
  PERMISSIONS,
  ALL_PERMISSIONS,
  SYSTEM_ROLES,
  PERMISSION_CATALOGUE,
  PERMISSION_CATEGORIES,
  SYSTEM_ROLE_KEYS,
  LOCKED_ROLE_KEY,
  defaultPermissionsFor,
  type Permission,
  type RoleSeed,
  type PermissionCategory,
  type PermissionInfo,
} from '@healthcloud/db';
