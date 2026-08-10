import { md5, partialMD5 } from '@/utils/md5';

/**
 * Compute the content-hash id for a local dictionary bundle at import
 * time. Uses partialMD5 (head + middle + tail sample) of the primary
 * file, mixed with byteSize and the sorted filename list. The mixing
 * keeps distinct bundle layouts from collapsing onto the same id.
 *
 * Stardict primary = .ifo (small text; partialMD5 is effectively full-hash).
 * MDict primary    = .mdx (body).
 * DICT primary     = .dict.dz (compressed body).
 * Slob primary     = .slob (single-file bundle).
 */
export const computeDictionaryContentId = async (
  primary: File,
  filenames: string[],
): Promise<string> => {
  const partial = await partialMD5(primary);
  const bundle = [partial, String(primary.size), ...[...filenames].sort()].join('|');
  return md5(bundle);
};
