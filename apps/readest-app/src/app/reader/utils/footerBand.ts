import type { ViewSettings } from '@/types/book';

/**
 * Whether the footer currently displays any info widget, mirroring the
 * per-widget gating in ProgressBar.
 */
export const footerInfoVisible = (viewSettings: ViewSettings): boolean =>
  !!(
    viewSettings.showRemainingTime ||
    viewSettings.showRemainingPages ||
    viewSettings.showProgressInfo ||
    viewSettings.showCurrentTime ||
    viewSettings.showCurrentBatteryStatus
  );

/**
 * Whether the book layout must reserve the full-width bottom band
 * (marginBottomPx of page margin / scroll padding) for the footer.
 *
 * The band used to be reserved whenever Show Footer was on, which read as a
 * "solid bar" across the bottom of the screen: scrolled text clipped hard at
 * its edge, and it lingered even when the footer had nothing to show. Now:
 *   - scrolled mode keeps the band whenever the footer is on, so the section
 *     title in the bottom-left corner never overlaps the running text
 *   - paginated mode reserves it only while some info actually renders
 */
export const footerReservesBand = (viewSettings: ViewSettings): boolean => {
  if (!viewSettings.showFooter) return false;
  if (viewSettings.scrolled) return true;
  return footerInfoVisible(viewSettings);
};
