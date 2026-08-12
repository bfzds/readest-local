import clsx from 'clsx';
import React, { useCallback, useEffect } from 'react';
import { RiArrowLeftSLine, RiArrowRightSLine } from 'react-icons/ri';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { NavigationHandlers } from './types';
import { getNavigationIcon } from './utils';
import Button from '@/components/Button';
import Slider from '@/components/Slider';
import PageJumpInput from './PageJumpInput';

interface NavigationPanelProps {
  bookKey: string;
  actionTab: string;
  progressFraction: number;
  progressValid: boolean;
  navigationHandlers: NavigationHandlers;
  bottomOffset: string;
  sliderHeight: number;
  forceMobileLayout: boolean;
}

export const NavigationPanel: React.FC<NavigationPanelProps> = ({
  bookKey,
  actionTab,
  progressFraction,
  progressValid,
  navigationHandlers,
  bottomOffset,
  sliderHeight,
  forceMobileLayout,
}) => {
  const _ = useTranslation();
  const { getViewSettings } = useReaderStore();
  const viewSettings = getViewSettings(bookKey);

  const [progressValue, setProgressValue] = React.useState(
    progressValid ? progressFraction * 100 : 0,
  );

  useEffect(() => {
    if (progressValid) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProgressValue(progressFraction * 100);
    }
  }, [progressValid, progressFraction]);

  const handleProgressChange = useCallback(
    (value: number) => {
      setProgressValue(value);
      navigationHandlers.onProgressChange(value);
    },
    [navigationHandlers],
  );

  const showPageNavigationButtons = viewSettings?.showPageNavigationButtons;

  const classes = clsx(
    'footerbar-progress-mobile not-eink:bg-base-200 eink:bg-base-100 absolute flex w-full flex-col items-center gap-y-8 px-4 transition-all',
    'eink:border-base-content eink:border-t',
    !forceMobileLayout && 'sm:hidden',
    // Paddings stay constant in both states (the slide is transform-only) so
    // offsetHeight always reports the panel's settled height; the TTS mini
    // player measures it to stack above the expanded panel.
    'pb-4 pt-8',
    actionTab === 'progress'
      ? 'pointer-events-auto translate-y-0 ease-out'
      : 'pointer-events-none invisible translate-y-full overflow-hidden ease-in',
  );

  return (
    <div
      className={classes}
      style={{
        bottom: bottomOffset,
      }}
    >
      <div className='flex w-full flex-col items-center gap-y-4'>
        {progressValid && (
          <div className='eink-bordered bg-base-100 rounded-full px-2 py-1'>
            <PageJumpInput bookKey={bookKey} showFraction className='text-base' />
          </div>
        )}
        <div className='flex w-full items-center justify-between gap-x-6'>
          <Slider
            label={_('Reading Progress')}
            heightPx={sliderHeight}
            bubbleLabel={`${Math.round(progressValue)}%`}
            initialValue={progressValue}
            onChange={handleProgressChange}
          />
        </div>
      </div>
      <div className='grid w-full grid-cols-[1fr_auto_1fr] items-center gap-x-6'>
        <div className='flex items-center justify-start gap-x-6'>
          {showPageNavigationButtons && (
            <Button
              icon={getNavigationIcon(
                viewSettings?.rtl,
                <RiArrowLeftSLine />,
                <RiArrowRightSLine />,
              )}
              onClick={navigationHandlers.onPrevPage}
              label={_('Previous Page')}
            />
          )}
        </div>
        <div />
        <div className='flex items-center justify-end gap-x-6'>
          {showPageNavigationButtons && (
            <Button
              icon={getNavigationIcon(
                viewSettings?.rtl,
                <RiArrowRightSLine />,
                <RiArrowLeftSLine />,
              )}
              onClick={navigationHandlers.onNextPage}
              label={_('Next Page')}
            />
          )}
        </div>
      </div>
    </div>
  );
};
