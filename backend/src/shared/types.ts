// Thin re-export shim — the canonical definitions live in ./contract
// (the shared API contract, mirrored byte-identically at frontend/lib/contract.ts).
// Kept so existing `from '../shared/types'` imports keep working; new code
// should import from '../shared/contract' directly.

export type { UserRole, AuthUser, JwtPayload, ApiResponse } from './contract';
