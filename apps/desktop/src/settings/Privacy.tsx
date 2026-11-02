import { Page } from "./parts";

/** The plain privacy statement, as the vision puts it. */
export const PRIVACY =
  "Your writing, collection and Kin's memory stay on this Mac. What leaves it: calls to your own AI provider with your own key, fetching the sources you follow or save, and downloads of optional tools you agree to. Nothing is used for training.";

/** Settings › Privacy. */
export function PrivacySettings() {
  return (
    <Page title="Privacy">
      <p className="ki-settings-prose" data-testid="privacy">{PRIVACY}</p>
    </Page>
  );
}
