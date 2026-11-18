import { installOwnerDesktopConversationGate } from './gate.mjs';
export const name = 'surfcore-owner-desktop-conversation-boundary';
export const inject = ['tools'];
export function apply(ctx) { installOwnerDesktopConversationGate(ctx); }
