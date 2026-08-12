import clsx from 'clsx';
import React from 'react';
import { RxSlider as SliderIcon } from 'react-icons/rx';
import { RiFontFamily as FontIcon } from 'react-icons/ri';
import { PiSun as ColorIcon } from 'react-icons/pi';
import { MdOutlineHeadphones as TTSIcon } from 'react-icons/md';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import Button from '@/components/Button';
import { Insets } from '@/types/misc';

interface NavigationBarProps {
  bookKey: string;
  actionTab: string;
  gridInsets: Insets;
  forceMobileLayout: boolean;
  onSetActionTab: (tab: string) => void;
}

export const NavigationBar: React.FC<NavigationBarProps> = ({
  bookKey,
  actionTab,
  gridInsets,
  forceMobileLayout,
  onSetActionTab,
}) => {
  const isMobile = forceMobileLayout || window.innerWidth < 640 || window.innerHeight < 640;
  const _ = useTranslation();
  const { getViewState } = useReaderStore();

  const viewState = getViewState(bookKey);
  const fontIconSize = useResponsiveSize(18);
  const navPadding = isMobile ? `${gridInsets.bottom * 0.33 + 16}px` : '0px';

  return (
    <div
      className={clsx(
        'not-eink:bg-base-200 eink:bg-base-100 z-30 mt-auto flex w-full justify-between px-8 py-4',
        'eink:border-base-content eink:border-t',
        !forceMobileLayout && 'sm:hidden',
      )}
      style={{
        paddingBottom: navPadding,
      }}
    >
      <Button
        label={_('Color')}
        icon={<ColorIcon className={clsx(actionTab === 'color' && 'text-blue-500')} />}
        onClick={() => onSetActionTab('color')}
      />
      <Button
        label={_('Reading Progress')}
        icon={<SliderIcon className={clsx(actionTab === 'progress' && 'text-blue-500')} />}
        onClick={() => onSetActionTab('progress')}
      />
      <Button
        label={_('Font & Layout')}
        icon={
          <FontIcon size={fontIconSize} className={clsx(actionTab === 'font' && 'text-blue-500')} />
        }
        onClick={() => onSetActionTab('font')}
      />
      <Button
        label={_('Speak')}
        icon={<TTSIcon className={viewState?.ttsEnabled ? 'text-blue-500' : ''} />}
        onClick={() => onSetActionTab('tts')}
      />
    </div>
  );
};
