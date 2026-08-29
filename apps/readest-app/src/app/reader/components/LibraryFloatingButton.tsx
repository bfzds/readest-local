import React from 'react';
import { RiBook2Line } from 'react-icons/ri';
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
      className='absolute bottom-72 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-64'
    >
      <RiBook2Line size={20} />
    </button>
  );
};

export default LibraryFloatingButton;
