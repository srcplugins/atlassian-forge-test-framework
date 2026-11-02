import { pageGuard as sharedPageGuard } from '../core/page-guard.mjs';
export { appReady, readinessStages } from '../core/page-guard.mjs';

// Opt-in foundation: selectors and Confluence host behavior still need a hosted smoke.
export const pageGuard = (context, options = {}) =>
  sharedPageGuard(context, { ...options, product: 'Confluence', requireFlagHeading: false });
