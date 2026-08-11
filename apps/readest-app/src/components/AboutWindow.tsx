import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { parseWebViewInfo } from '@/utils/ua';
import { getAppVersion } from '@/utils/version';
import { writeTextToClipboard } from '@/utils/clipboard';
import { eventDispatcher } from '@/utils/event';
import Dialog from './Dialog';

export const setAboutDialogVisible = (visible: boolean) => {
  const dialog = document.getElementById('about_window');
  if (dialog) {
    const event = new CustomEvent('setDialogVisibility', {
      detail: { visible },
    });
    dialog.dispatchEvent(event);
  }
};

export const AboutWindow = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [browserInfo, setBrowserInfo] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setBrowserInfo(parseWebViewInfo(appService));

    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
    };

    const el = document.getElementById('about_window');
    if (el) {
      el.addEventListener('setDialogVisibility', handleCustomEvent as EventListener);
    }

    return () => {
      if (el) {
        el.removeEventListener('setDialogVisibility', handleCustomEvent as EventListener);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = () => {
    setIsOpen(false);
  };

  const versionInfo = `${_('Version {{version}}', { version: getAppVersion() })} (${browserInfo})`;

  // Mobile users can't select the version string to paste it into a bug
  // report, so the label itself copies it.
  const handleCopyVersion = async () => {
    const copied = await writeTextToClipboard(versionInfo);
    if (!copied) return;
    eventDispatcher.dispatch('toast', {
      type: 'info',
      message: _('Copied to clipboard'),
      className: 'whitespace-nowrap',
      timeout: 2000,
    });
  };

  return (
    <Dialog
      id='about_window'
      isOpen={isOpen}
      title={_('About Readest')}
      onClose={handleClose}
      boxClassName='sm:!w-[480px] sm:!max-w-screen-sm sm:h-auto'
    >
      {isOpen && (
        <div className='about-content flex flex-col items-center justify-center gap-4 pb-10 sm:pb-0'>
          <div className='flex flex-1 flex-col items-center justify-end gap-2 px-8 py-2'>
            <div className='mb-2 mt-6'>
              <Image src='/icon.png' alt='App Logo' className='h-20 w-20' width={64} height={64} />
            </div>
            <div className='flex select-text flex-col items-center'>
              <h2 className='mb-2 text-2xl font-bold'>Readest</h2>
              <button
                type='button'
                title={_('Copy')}
                className='text-neutral-content text-center text-sm'
                onClick={handleCopyVersion}
              >
                {versionInfo}
              </button>
            </div>
          </div>

          <hr aria-hidden='true' className='border-base-300 my-12 w-full sm:my-4' />

          <div
            className='flex flex-1 flex-col items-center justify-start gap-2 px-4 text-center'
            dir='ltr'
          >
            <p className='text-neutral-content text-sm'>
              © {new Date().getFullYear()} Bilingify LLC. All rights reserved.
            </p>

            <p className='text-neutral-content text-xs'>
              This software is licensed under the GNU Affero General Public License v3.0. You are
              free to use, modify, and distribute this software under the terms of the AGPL v3
              license.
            </p>
          </div>
        </div>
      )}
    </Dialog>
  );
};
