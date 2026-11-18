// Keep host-only gate state beside the external preset. Removing/reloading the
// plugin package must not split its authority from the cached preset boundary.
export { isOwnerDesktopTool, armOwnerDesktopConversation, ownerDesktopConversationDenial, installOwnerDesktopConversationGate } from '../../../dsh/agent-presets/owner-desktop-conversation/gate.mjs';
