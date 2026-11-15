/**
 * What the bundled org modules use from src/onboarding.ts: its error class. The bundle maps src/onboarding.ts here so
 * it does not pull the SDK's provider layer (Claude, Codex, Cursor clients) into an extension that never runs a model.
 */
export class OnboardingError extends Error {
  override readonly name = "OnboardingError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
