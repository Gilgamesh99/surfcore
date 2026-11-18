// Compatibility entry point. New host consumers import the conversation options directly
// so an older external ESM cache cannot retain the former management-parent requirement.
export { OWNER_DESKTOP_DEFAULT_TIMEOUT_MS, OWNER_DESKTOP_MAX_TIMEOUT_MS, OWNER_DESKTOP_PENDING_TTL_MS, OWNER_DESKTOP_DEFAULTS, desktopConfigError, normalizeOwnerDesktopTimeout, normalizeOwnerDesktopSettings, readOwnerDesktopSettings } from './owner-desktop-conversation-options.js';
