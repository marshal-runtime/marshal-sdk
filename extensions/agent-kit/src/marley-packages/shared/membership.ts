/**
 * One definition of a brand member (Omer's order, 2026-11-13): a row of this brand exists. There is no owner, admin, active, pending or
 * disabled tier for access: nobody tracks disabled, and an operator deletes a row on request. The only checks are the brand fence (the row
 * is looked up inside the turn's brand) and the server-owned speaker identity; a row is never trusted from model or VM input.
 */
export const isMember = (row: object | null | undefined): boolean => row !== null && row !== undefined;

/**
 * Consent fact for a message Marley STARTS (a brief, a nudge, a greeting): the person has written to Marley from their number, which the
 * row records as status `active`. This is not access; use `isMember` for that. Never use it to gate what a member may do in their own chat.
 */
export const hasWritten = (row: { status: string | null } | null | undefined): boolean => row !== null && row !== undefined && row.status === "active";
