'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { BookDoc } from '@/libs/document';
import { useTranslation } from '@/hooks/useTranslation';
import { serializeEditedSection } from './sectionSerializer';

const EDITOR_CSS = `
  html, body { height: 100%; margin: 0; padding: 16px; }
  body { font-family: inherit; line-height: 1.7; overflow-y: auto; }
  img, a, sup, span { pointer-events: none; user-select: none; }
`;

export const EditorView: React.FC<{
  bookDoc: BookDoc;
  sectionIndex: number;
  onSave: (html: string) => Promise<void> | void;
  onCancel: () => void;
}> = ({ bookDoc, sectionIndex, onSave, onCancel }) => {
  const _ = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const originalHtmlRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const section = bookDoc.sections[sectionIndex];
    section
      ?.loadText?.()
      .then((text) => {
        if (cancelled || !text) return;
        originalHtmlRef.current = text;
        const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
        iframeRef.current?.setAttribute('srcdoc', new XMLSerializer().serializeToString(doc));
      })
      .catch(() => setError(_('Failed to parse EPUB')));
    return () => {
      cancelled = true;
    };
  }, [bookDoc, sectionIndex, _]);

  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = EDITOR_CSS;
    doc.head?.append(style);
    doc.body.setAttribute('contenteditable', 'true');
  }, []);

  const handleCancel = useCallback(() => {
    if (window.confirm(_('Unsaved changes will be lost'))) onCancel();
  }, [onCancel, _]);

  const handleSave = useCallback(async () => {
    const originalHtml = originalHtmlRef.current;
    const doc = iframeRef.current?.contentDocument;
    if (!originalHtml || !doc || saving) return;
    setError(null);
    try {
      const html = serializeEditedSection(originalHtml, new XMLSerializer().serializeToString(doc));
      setSaving(true);
      await onSave(html);
    } catch (e) {
      setError(e instanceof Error ? e.message : _('Save Changes'));
    } finally {
      setSaving(false);
    }
  }, [onSave, saving, _]);

  return (
    <div className='editor-view flex h-full w-full flex-col bg-base-100'>
      <div className='flex h-11 shrink-0 items-center justify-between px-4'>
        <span className='text-sm font-medium'>{_('Edit Book Content')}</span>
        <div className='flex items-center gap-2'>
          {error && <span className='text-sm text-error'>{error}</span>}
          <button
            className='btn btn-ghost h-8 min-h-8 px-3 text-sm'
            onClick={handleCancel}
            disabled={saving}
          >
            {_('Cancel')}
          </button>
          <button
            className='btn btn-primary h-8 min-h-8 px-3 text-sm'
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? `${_('Save')}…` : _('Save')}
          </button>
        </div>
      </div>
      <iframe
        ref={iframeRef}
        className='w-full flex-1 border-0'
        sandbox='allow-same-origin'
        title={_('Edit Book Content')}
        onLoad={handleIframeLoad}
      />
    </div>
  );
};
