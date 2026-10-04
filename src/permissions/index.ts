export type { PermissionRule, PermissionConfig, PermissionResult, PermissionAction, PermissionCheckContext } from "./types.js";
export { evaluate, extractPrimaryArg } from "./matcher.js";
export { extractPathCandidates, matchProtectedPath } from "./paths.js";
export { PermissionGuard, parseConfirmation } from "./guard.js";
export type { ConfirmFn, GuardOptions } from "./guard.js";
export { loadPermissionConfig } from "./config.js";
export { defaultRules, defaultProtectedPaths } from "./defaults.js";