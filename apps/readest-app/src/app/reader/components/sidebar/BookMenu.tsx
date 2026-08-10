import clsx from 'clsx';
import React from 'react';

import { MdCheck } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { isWebAppPlatform } from '@/services/environment';
import { eventDispatcher } from '@/utils/event';
import { DOWNLOAD_READEST_URL } from '@/services/constants';
import { saveViewSettings } from '@/helpers/settings';
import { setProofreadRulesVisibility } from '@/app/reader/components/ProofreadRules';
import { setAboutDialogVisible } from '@/components/AboutWindow';
import MenuItem from '@/components/MenuItem';
import Menu from '@/components/Menu';

interface BookMenuProps {
  menuClassName?: string;
  setIsDropdownOpen?: (isOpen: boolean) => void;
}

const BookMenu: React.FC<BookMenuProps> = ({ menuClassName, setIsDropdownOpen }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings } = useSettingsStore();
  const { recreateViewer, getViewSettings } = useReaderStore();
  const { sideBarBookKey } = useSidebarStore();
  const { getConfig } = useBookDataStore();
  const viewSettings = getViewSettings(sideBarBookKey!);

  const [isSortedTOC, setIsSortedTOC] = React.useState(viewSettings?.sortedTOC || false);

  // Used purely to grey out "Clear Annotations" when there's nothing to
  // clear. The actual delete + confirm dialog lives in Annotator (which
  // outlives this dropdown menu, so the dialog isn't unmounted along
  // with the menu when the user clicks the entry).
  const annotationsToClear = React.useMemo(() => {
    if (!sideBarBookKey) return 0;
    const cfg = getConfig(sideBarBookKey);
    if (!cfg?.booknotes) return 0;
    return cfg.booknotes.filter((n) => n.type === 'annotation' && !n.deletedAt).length;
  }, [sideBarBookKey, getConfig]);

  const handleReloadPage = () => {
    window.location.reload();
    setIsDropdownOpen?.(false);
  };
  const showAboutReadest = () => {
    setAboutDialogVisible(true);
    setIsDropdownOpen?.(false);
  };
  const downloadReadest = () => {
    window.open(DOWNLOAD_READEST_URL, '_blank');
    setIsDropdownOpen?.(false);
  };
  const handleExportAnnotations = () => {
    eventDispatcher.dispatch('export-annotations', { bookKey: sideBarBookKey });
    setIsDropdownOpen?.(false);
  };
  const handleImportAnnotations = () => {
    eventDispatcher.dispatch('import-annotations', { bookKey: sideBarBookKey });
    setIsDropdownOpen?.(false);
  };
  const handleToggleSortTOC = () => {
    setIsSortedTOC((prev) => !prev);
    setIsDropdownOpen?.(false);
    if (sideBarBookKey) {
      saveViewSettings(envConfig, sideBarBookKey, 'sortedTOC', !isSortedTOC, true, false).then(
        () => {
          recreateViewer(envConfig, sideBarBookKey);
        },
      );
    }
  };
  const showProofreadRulesWindow = () => {
    setProofreadRulesVisibility(true);
    setIsDropdownOpen?.(false);
  };
  const handlePullKOSync = () => {
    eventDispatcher.dispatch('pull-kosync', { bookKey: sideBarBookKey });
    setIsDropdownOpen?.(false);
  };
  const handlePushKOSync = () => {
    eventDispatcher.dispatch('push-kosync', { bookKey: sideBarBookKey });
    setIsDropdownOpen?.(false);
  };
  const handlePushReadwise = () => {
    eventDispatcher.dispatch('readwise-push-all', { bookKey: sideBarBookKey });
    setIsDropdownOpen?.(false);
  };
  const handlePushHardcoverNotes = () => {
    eventDispatcher.dispatch('hardcover-push-notes', { bookKey: sideBarBookKey });
    setIsDropdownOpen?.(false);
  };
  const handlePushHardcoverProgress = () => {
    eventDispatcher.dispatch('hardcover-push-progress', { bookKey: sideBarBookKey });
    setIsDropdownOpen?.(false);
  };
  // Routed through Annotator (per-book, long-lived) so that the
  // confirmation dialog isn't unmounted with the dropdown menu.
  const handleClearAnnotations = () => {
    eventDispatcher.dispatch('clear-annotations', { bookKey: sideBarBookKey });
    setIsDropdownOpen?.(false);
  };

  return (
    <Menu
      className={clsx('book-menu dropdown-content z-20 shadow-2xl', menuClassName)}
      onCancel={() => setIsDropdownOpen?.(false)}
    >
      {(settings.kosync.enabled || settings.readwise.enabled || settings.hardcover.enabled) && (
        <hr aria-hidden='true' className='border-base-200 my-1' />
      )}
      {settings.kosync.enabled && (
        <MenuItem label={_('KOReader Sync')} detailsOpen={false} buttonClass='py-2'>
          <ul className='flex flex-col ps-1'>
            <MenuItem label={_('Push Progress')} noIcon onClick={handlePushKOSync} />
            <MenuItem label={_('Pull Progress')} noIcon onClick={handlePullKOSync} />
          </ul>
        </MenuItem>
      )}
      {settings.readwise.enabled && (
        <MenuItem label={_('Readwise Sync')} detailsOpen={false} buttonClass='py-2'>
          <ul className='flex flex-col ps-1'>
            <MenuItem label={_('Push Highlights')} noIcon onClick={handlePushReadwise} />
          </ul>
        </MenuItem>
      )}
      {settings.hardcover.enabled && (
        <MenuItem label={_('Hardcover Sync')} detailsOpen={false} buttonClass='py-2'>
          <ul className='flex flex-col ps-1'>
            <MenuItem label={_('Push Progress')} noIcon onClick={handlePushHardcoverProgress} />
            <MenuItem label={_('Push Notes')} noIcon onClick={handlePushHardcoverNotes} />
          </ul>
        </MenuItem>
      )}
      <hr aria-hidden='true' className='border-base-200 my-1' />
      <MenuItem label={_('Proofread')} onClick={showProofreadRulesWindow} />
      <hr aria-hidden='true' className='border-base-200 my-1' />
      <MenuItem label={_('Export Annotations')} onClick={handleExportAnnotations} />
      <MenuItem label={_('Import Annotations')} onClick={handleImportAnnotations} />
      <MenuItem
        label={_('Clear Annotations')}
        disabled={annotationsToClear === 0}
        onClick={handleClearAnnotations}
      />
      <MenuItem
        label={_('Sort TOC by Page')}
        Icon={isSortedTOC ? MdCheck : undefined}
        onClick={handleToggleSortTOC}
      />
      <MenuItem label={_('Reload Page')} shortcut='Shift+R' onClick={handleReloadPage} />
      <hr aria-hidden='true' className='border-base-200 my-1' />
      {isWebAppPlatform() && <MenuItem label={_('Download Readest')} onClick={downloadReadest} />}
      <MenuItem label={_('About Readest')} onClick={showAboutReadest} />
    </Menu>
  );
};

export default BookMenu;
