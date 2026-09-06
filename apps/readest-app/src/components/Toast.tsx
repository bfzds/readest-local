import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { MdCheckCircle, MdClose, MdError, MdInfo, MdWarning } from 'react-icons/md';
import { useThemeStore } from '@/store/themeStore';
import { eventDispatcher } from '@/utils/event';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

interface ActiveToast {
  // Monotonic id: identical consecutive messages must re-arm the timer (and
  // restart the fade-in) rather than being swallowed by same-value state.
  id: number;
  message: string;
  type: ToastType;
  timeout: number;
  messageClass: string;
  callback: (() => void) | null;
}

export const Toast = () => {
  const { safeAreaInsets } = useThemeStore();
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const idRef = useRef(0);
  const toastDismissTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toastClassMap = {
    info: 'toast-info toast-center toast-middle',
    success: 'toast-success toast-top sm:toast-end toast-center',
    warning: 'toast-warning toast-top sm:toast-end toast-center',
    error: 'toast-error toast-top sm:toast-end toast-center',
  };

  const alertClassMap = {
    info: 'alert-primary border-base-300',
    success: 'alert-success not-eink:from-green-500 not-eink:to-emerald-500',
    warning: 'alert-warning not-eink:from-amber-500 not-eink:to-orange-500',
    error: 'alert-error not-eink:from-red-500 not-eink:to-rose-500',
  };

  const iconMap = {
    info: <MdInfo className='h-5 w-5' aria-hidden />,
    success: <MdCheckCircle className='h-5 w-5' aria-hidden />,
    warning: <MdWarning className='h-5 w-5' aria-hidden />,
    error: <MdError className='h-5 w-5' aria-hidden />,
  };

  // One effect owns the whole lifecycle of the current toast: fade-in, the
  // auto-dismiss timer, and the callback. Every new toast (new id) re-arms
  // everything, so a custom timeout can't leak into later toasts and a
  // callback fires exactly when ITS toast finishes — not on a stale timer.
  useEffect(() => {
    if (!toast) return;
    const showTimer = setTimeout(() => {
      setIsVisible(true);
    }, 0);
    const dismissTimer = setTimeout(() => {
      setIsVisible(false);
      toast.callback?.();
      setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 300);
    }, toast.timeout);
    toastDismissTimeout.current = dismissTimer;
    return () => {
      clearTimeout(showTimer);
      clearTimeout(dismissTimer);
    };
  }, [toast]);

  const handleShowToast = async (event: CustomEvent) => {
    const { message, type = 'info', timeout, className = '', callback = null } = event.detail;
    idRef.current += 1;
    setToast({
      id: idRef.current,
      message,
      type,
      timeout: timeout || 5000,
      messageClass: className,
      callback: typeof callback === 'function' ? callback : null,
    });
  };

  useEffect(() => {
    eventDispatcher.on('toast', handleShowToast);
    return () => {
      eventDispatcher.off('toast', handleShowToast);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDismiss = () => {
    if (toastDismissTimeout.current) clearTimeout(toastDismissTimeout.current);
    // Manual dismiss cancels the pending callback too: the user explicitly
    // closed the toast, so its "done" action should not fire later anyway.
    setToast((cur) => (cur ? { ...cur, callback: null } : cur));
    setIsVisible(false);
    const currentId = toast?.id;
    setTimeout(() => setToast((cur) => (cur?.id === currentId ? null : cur)), 300);
  };

  return (
    toast && (
      <div
        data-capture-invalidating-overlay='true'
        className={clsx(
          'toast z-[130] w-auto max-w-screen-sm transition-all duration-300',
          toastClassMap[toast.type],
          isVisible ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
        )}
        style={{
          top: toastClassMap[toast.type].includes('toast-top')
            ? `${(safeAreaInsets?.top || 0) + 44}px`
            : undefined,
        }}
      >
        <div
          className={clsx(
            'alert flex items-center gap-3 shadow-2xl backdrop-blur-sm',
            'min-h-0 rounded-2xl px-5 py-4',
            'not-eink:bg-gradient-to-r border-0',
            alertClassMap[toast.type],
            'eink:bg-base-100 eink:border eink:border-base-content',
            toast.type !== 'info' && 'text-white',
          )}
        >
          {/* Icon */}
          <div className='flex-shrink-0'>{iconMap[toast.type]}</div>

          {/* Message */}
          <span
            className={clsx(
              'max-h-[50vh] flex-1 overflow-y-auto',
              'font-sans text-base font-medium leading-snug sm:text-sm',
              toast.type === 'info'
                ? 'max-w-[60vw] truncate sm:max-w-[80vw]'
                : 'min-w-[60vw] max-w-[80vw] whitespace-normal break-words sm:min-w-40 sm:max-w-80',
              toast.messageClass,
            )}
          >
            {toast.message.split('\n').map((line, idx) => (
              <React.Fragment key={idx}>
                {line || <>&nbsp;</>}
                {idx < toast.message.split('\n').length - 1 && <br />}
              </React.Fragment>
            ))}
          </span>

          {/* Close button */}
          <button
            onClick={handleDismiss}
            className={clsx(
              'flex-shrink-0 rounded-lg p-1 transition-colors',
              toast.type === 'info'
                ? 'hover:bg-base-300 hidden'
                : 'hover:bg-white/20 active:bg-white/30',
            )}
            aria-label='Dismiss'
          >
            <MdClose className='h-4 w-4' aria-hidden />
          </button>
        </div>
      </div>
    )
  );
};
