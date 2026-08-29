import React, { useCallback } from 'react';
import { RiHeadphoneLine } from 'react-icons/ri';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';

// Desktop toolbar was removed (see FooterBar); the Read-Aloud entry point is a
// floating button in the bottom-right stack, above the Search button.
const FloatingSpeakButton: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { getView, getViewState } = useReaderStore();
  const viewState = getViewState?.(bookKey);

  const handleSpeak = useCallback(() => {
    if (!getView?.(bookKey)) return;
    eventDispatcher.dispatch(viewState?.ttsEnabled ? 'tts-stop' : 'tts-speak', { bookKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, getView, viewState?.ttsEnabled]);

  return (
    <button
      type='button'
      aria-label={_('Speak')}
      title={_('Speak')}
      onClick={handleSpeak}
      className='absolute bottom-56 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-48'
    >
      <RiHeadphoneLine size={20} className={viewState?.ttsEnabled ? 'text-blue-500' : ''} />
    </button>
  );
};

export default FloatingSpeakButton;
