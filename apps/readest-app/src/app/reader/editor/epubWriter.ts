import {
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';

export interface ZipEntryData {
  name: string;
  data: Uint8Array;
}

const EPUB_MIME = 'application/epub+zip';
const MIMETYPE_ENTRY = 'mimetype';
// 复用 TxtToEpubConverter 的时间戳策略，保证无变化重建稳定
const zipWriteOptions = {
  lastAccessDate: new Date(0),
  lastModDate: new Date(0),
};

export async function readZipEntries(file: Blob): Promise<ZipEntryData[]> {
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const result: ZipEntryData[] = [];
    for (const entry of entries) {
      // 目录项没有字节内容，EPUB 内容均为文件，跳过目录项
      if (entry.directory) continue;
      const data = await entry.getData(new Uint8ArrayWriter());
      result.push({ name: entry.filename, data });
    }
    return result;
  } finally {
    await reader.close();
  }
}

export async function rewriteEpub(
  entries: ZipEntryData[],
  targetName: string,
  newData: Uint8Array,
): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter(EPUB_MIME), { extendedTimestamp: false });
  for (const entry of entries) {
    const data = entry.name === targetName ? newData : entry.data;
    await writer.add(entry.name, new Uint8ArrayReader(data), {
      ...zipWriteOptions,
      // EPUB 3 requires mimetype as the first entry, uncompressed.
      level: entry.name === MIMETYPE_ENTRY ? 0 : 6,
    });
  }
  return await writer.close();
}
