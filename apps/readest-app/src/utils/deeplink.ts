export type AnnotationDeepLink = {
  bookHash: string;
  noteId: string;
  cfi?: string;
};

/**
 * Build the custom-scheme URL for an annotation. Used in markdown export and
 * copy-link flows. The offline desktop build has no universal web landing page.
 */
export const buildAnnotationAppUrl = ({ bookHash, noteId, cfi }: AnnotationDeepLink): string => {
  const base = `readest://book/${bookHash}/annotation/${noteId}`;
  return cfi ? `${base}?cfi=${encodeURIComponent(cfi)}` : base;
};

/**
 * Parse an incoming readest:// annotation URL. Accepts the hierarchical form
 * (book/{hash}/annotation/{id}) and the legacy flat form
 * (annotation/{hash}/{id}). Returns null if the URL doesn't match.
 */
export const parseAnnotationDeepLink = (url: string): AnnotationDeepLink | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'readest:') return null;

  // For readest:// URLs the URL parser stores the first path segment in the
  // host. Reconstruct a uniform segment list.
  const segments = [parsed.host, ...parsed.pathname.split('/')].filter(Boolean);
  const cfiParam = parsed.searchParams.get('cfi');
  const cfi = cfiParam ? cfiParam : undefined;

  // Hierarchical: book/{hash}/annotation/{id}
  if (segments.length === 4 && segments[0] === 'book' && segments[2] === 'annotation') {
    return { bookHash: segments[1]!, noteId: segments[3]!, cfi };
  }

  // Legacy flat: annotation/{hash}/{id}
  if (segments.length === 3 && segments[0] === 'annotation') {
    return { bookHash: segments[1]!, noteId: segments[2]!, cfi };
  }

  return null;
};

/**
 * Parse an incoming readest:// book-open URL. Matches only the bare form
 * book/{hash} (the widget tap target); the 4-segment annotation form
 * book/{hash}/annotation/{id} is handled by parseAnnotationDeepLink and must
 * NOT match here.
 */
export const parseBookDeepLink = (url: string): { bookHash: string; autoplay?: boolean } | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'readest:') return null;

  const segments = [parsed.host, ...parsed.pathname.split('/')].filter(Boolean);
  if (segments.length === 2 && segments[0] === 'book' && segments[1]) {
    // `?autoplay=tts` is appended by the Android Auto cold-resume launch to ask
    // the reader to start read-aloud once the book is open. Only surface the
    // flag when set so the common shape stays `{ bookHash }`.
    if (parsed.searchParams.get('autoplay') === 'tts') {
      return { bookHash: segments[1], autoplay: true };
    }
    return { bookHash: segments[1] };
  }
  return null;
};
