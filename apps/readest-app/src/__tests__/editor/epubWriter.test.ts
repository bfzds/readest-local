import { describe, expect, it } from 'vitest';
import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import type { Entry } from '@zip.js/zip.js';

import { readZipEntries, rewriteEpub } from '@/app/reader/editor/epubWriter';

// getData 只存在于 FileEntry（目录项没有字节内容），用 directory 判别收窄类型
const readEntryText = (entry: Entry): Promise<string> => {
  if (entry.directory) {
    throw new Error(`unexpected directory entry: ${entry.filename}`);
  }
  return entry.getData(new TextWriter());
};

const MIMETYPE = 'application/epub+zip';
const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Editor Test</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookID">urn:uuid:12345</dc:identifier>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>`;
const chapter = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>${text}</p></body></html>`;

const makeEpub = async (): Promise<Blob> => {
  const zipWriter = new ZipWriter(new BlobWriter(MIMETYPE), { extendedTimestamp: false });
  await zipWriter.add('mimetype', new TextReader(MIMETYPE), { level: 0 });
  await zipWriter.add('META-INF/container.xml', new TextReader(CONTAINER));
  await zipWriter.add('OEBPS/content.opf', new TextReader(OPF));
  await zipWriter.add('OEBPS/chapter1.xhtml', new TextReader(chapter('Chapter 1')));
  await zipWriter.add('OEBPS/chapter2.xhtml', new TextReader(chapter('Chapter 2')));
  return zipWriter.close();
};

describe('epubWriter', () => {
  it('reads every zip entry with raw bytes', async () => {
    const entries = await readZipEntries(await makeEpub());
    expect(entries.map((e) => e.name)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/chapter1.xhtml',
      'OEBPS/chapter2.xhtml',
    ]);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe(MIMETYPE);
  });

  it('keeps mimetype first and replaces only the target chapter', async () => {
    const entries = await readZipEntries(await makeEpub());
    const edited = chapter('Edited chapter 2');
    const blob = await rewriteEpub(
      entries,
      'OEBPS/chapter2.xhtml',
      new TextEncoder().encode(edited),
    );

    const reader = new ZipReader(new BlobReader(blob));
    const out = await reader.getEntries();
    await reader.close();
    expect(out[0]!.filename).toBe('mimetype');
    expect(await readEntryText(out[0]!)).toBe(MIMETYPE);
    expect(await readEntryText(out[1]!)).toBe(CONTAINER);
    expect(await readEntryText(out[3]!)).toBe(chapter('Chapter 1'));
    expect(await readEntryText(out[4]!)).toBe(edited);
  });
});
