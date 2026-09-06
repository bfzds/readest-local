import { useEffect } from 'react';

/**
 * Layered Escape handling for the reader's stacked surfaces (note editor >
 * notebook > sidebar/search). Every panel registers a handler for the time it
 * is on screen; an Escape press goes to the TOP of the stack only, and falls
 * through to lower layers only when that handler does not consume it.
 *
 * This replaces the previous free-for-all where every panel registered its own
 * window keydown and one Esc press closed all of them at once (and silently
 * discarded the note being edited).
 */
type EscapeHandler = () => boolean | void;

interface EscapeEntry {
  id: string;
  handler: EscapeHandler;
}

const stack: EscapeEntry[] = [];

export const pushEscapeHandler = (id: string, handler: EscapeHandler) => {
  const existing = stack.findIndex((entry) => entry.id === id);
  if (existing !== -1) {
    // Re-registration keeps the layer's position; only the handler refreshes.
    stack[existing]!.handler = handler;
    return;
  }
  stack.push({ id, handler });
};

export const popEscapeHandler = (id: string) => {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index !== -1) stack.splice(index, 1);
};

/** Top-down dispatch; returns true when some layer consumed the Escape. */
export const handleEscapeStack = (): boolean => {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.handler() !== false) {
      return true;
    }
  }
  return false;
};

const isEditableTarget = (el: HTMLElement | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

// Editing surfaces that own Escape: the note editor textarea cancels the edit,
// and the search input lets the sidebar layer collapse the search. Everything
// else (generic inputs) keeps native behaviour.
const isEscapeOwningEditable = (el: HTMLElement | null) =>
  !!el && (el.classList.contains('note-editor') || el.closest('[data-escape-stack-exempt]'));

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const target = event.target as HTMLElement | null;
    if (isEditableTarget(target) && !isEscapeOwningEditable(target)) return;
    if (handleEscapeStack()) {
      event.preventDefault();
    }
  });
}

/** Register a layer's Escape handler for as long as `enabled` holds. */
export const useEscapeHandler = (id: string, handler: EscapeHandler, enabled = true) => {
  useEffect(() => {
    if (!enabled) return;
    pushEscapeHandler(id, handler);
    return () => popEscapeHandler(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled]);
};
