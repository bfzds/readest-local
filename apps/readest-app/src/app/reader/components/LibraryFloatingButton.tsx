import React from 'react';
import { VscLibrary } from 'react-icons/vsc';
import { useTranslation } from '@/hooks/useTranslation';

interface LibraryFloatingButtonProps {
  onGoToLibrary: () => void;
}

const LibraryFloatingButton: React.FC<LibraryFloatingButtonProps> = ({ onGoToLibrary }) => {
  const _ = useTranslation();

  return (
    <button
      type='button'
      aria-label={_('Back to library')}
      title={_('Back to library')}
      onClick={onGoToLibrary}
      className='absolute bottom-56 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-48'
    >
      <VscLibrary size={20} className='fill-base-content' />
    </button>
  );
};

export default LibraryFloatingButton;
