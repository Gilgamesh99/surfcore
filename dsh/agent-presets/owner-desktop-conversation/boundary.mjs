import { installOwnerDesktopConversationGate } from '../../../plugins/surfcore/lib/owner-desktop-conversation-gate.js';
export const name = 'surfcore-owner-desktop-conversation-boundary';
export const inject = ['tools'];
export function apply(ctx) { installOwnerDesktopConversationGate(ctx); }
