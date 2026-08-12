/**
 * Publish the home-screen reading-widget snapshot. The widget is only
 * visible on mobile while the app is backgrounded. The app no longer targets
 * mobile, so there is nothing to publish on desktop.
 */
export function useReadingWidget() {
  // No-op on desktop: the home-screen reading widget is mobile-only.
}
