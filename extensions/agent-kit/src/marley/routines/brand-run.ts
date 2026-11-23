/**
 * The Meta analysis (ua-cbo) and the morning-brief build (owner-report-daily) depend on no person: they run for every brand, owner or not, as the server's own
 * scheduled runs in a conversation of their own (inspector channel, nothing is ever sent from it). Their routine records name this member, which is no directory
 * member: it has no private scope, and it is accepted only as the speaker of the scheduler's own rows in that conversation.
 */
export const BRAND_RUN_MEMBER = "brand-run";
export const brandRunConversationId = (brandId: string): string => `brand-run-${brandId}`;
/** The inspector's "run this routine now" opens a conversation of its own per run (service.ts startTestRun: `insp-<member>-run<time>`); a brand-level routine's row there speaks for no person either. */
export const isBrandRunConversation = (brandId: string, conversationId: string): boolean =>
  conversationId === brandRunConversationId(brandId) || conversationId.startsWith(`insp-${BRAND_RUN_MEMBER}-run`);
export const isBrandRunMember = (memberId: string | null | undefined): boolean => memberId === BRAND_RUN_MEMBER;
