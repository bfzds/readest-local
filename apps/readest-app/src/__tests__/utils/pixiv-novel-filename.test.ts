// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parsePixivNovelFilename, parsePixivNovelMetaHeader } from '@/utils/pixivNovel';

describe('parsePixivNovelFilename', () => {
  it('parses the default pixiv/{user}-{user_id}/{id}-{title} layout', () => {
    expect(parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题.txt')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('parses the layout without the pixiv/ prefix', () => {
    expect(parsePixivNovelFilename('作者A-12345678/23456789-小说标题.txt')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('strips trailing date, sequence and bracket decorations', () => {
    expect(
      parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题-2024-01-01.txt'),
    ).toEqual({ title: '小说标题', author: '作者A', novelId: '23456789' });
    expect(parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题-p1.txt')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
    expect(
      parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题 (12345678).txt'),
    ).toEqual({ title: '小说标题', author: '作者A', novelId: '23456789' });
    expect(parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题【AI】.txt')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('parses the merged-series default layout', () => {
    expect(
      parsePixivNovelFilename('novel series/作者A/系列标题-34567890-作者A-01-标签1,标签2.txt'),
    ).toEqual({ title: '系列标题', author: '作者A', seriesId: '34567890' });
    expect(
      parsePixivNovelFilename('novel series/系列标题-34567890-作者A--标签1,标签2.txt'),
    ).toEqual({ title: '系列标题', author: '作者A', seriesId: '34567890' });
  });

  it('parses custom {user}-{user_id}-{id}-{title} names', () => {
    expect(parsePixivNovelFilename('作者A-12345678-23456789-小说标题.txt')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('parses custom {date}-{user_id}-{id}-{title} names without an author', () => {
    expect(parsePixivNovelFilename('2024-01-01-12345678-23456789-小说标题.txt')).toEqual({
      title: '小说标题',
      novelId: '23456789',
    });
  });

  it('parses custom {title}-{id}-{user} names without a pixiv directory', () => {
    expect(parsePixivNovelFilename('异世界魔物娘收容-1501076-kof_boss.txt')).toEqual({
      title: '异世界魔物娘收容',
      author: 'kof_boss',
      novelId: '1501076',
    });
  });

  it('strips {tags} appended after {user} in the downloader naming rule', () => {
    expect(
      parsePixivNovelFilename(
        '撞破舍友女装后，她和女友的修罗场-12542541-烟斗-伪娘,NTR,巨乳／乳交／豪乳／哺乳／喂奶／吃奶,足控,丝袜／足交／美足／丝足,淫语,恋物癖,中文／中国语.txt',
      ),
    ).toEqual({
      title: '撞破舍友女装后，她和女友的修罗场',
      author: '烟斗',
      novelId: '12542541',
    });
  });

  it('does not mistake common volume words for a pixiv username', () => {
    expect(parsePixivNovelFilename('我的书-12345678-下册.txt')).toBeNull();
    expect(parsePixivNovelFilename('我的书-12345678-第1章.txt')).toBeNull();
  });

  it('parses EPUB filenames as well', () => {
    expect(parsePixivNovelFilename('pixiv/作者A-12345678/23456789-小说标题.epub')).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('leaves ordinary filenames untouched', () => {
    expect(parsePixivNovelFilename('普通小说.txt')).toBeNull();
    expect(parsePixivNovelFilename('《三体》.txt')).toBeNull();
    expect(parsePixivNovelFilename('小说标题-2024-01-01.txt')).toBeNull();
    expect(parsePixivNovelFilename('')).toBeNull();
  });
});

describe('parsePixivNovelMetaHeader', () => {
  it('parses the single-novel TXT header written by the downloader', () => {
    const content = [
      '小说标题',
      '',
      '作者A',
      '',
      'https://www.pixiv.net/novel/show.php?id=23456789',
      '',
      '2024-01-01',
      '',
      '#tag1',
      '',
      '简介',
      '',
      '----- 下面是正文 -----',
      '',
      '正文内容',
    ].join('\n');
    expect(parsePixivNovelMetaHeader(content)).toEqual({
      title: '小说标题',
      author: '作者A',
      novelId: '23456789',
    });
  });

  it('parses the merged-series TXT header written by the downloader', () => {
    const content = [
      '系列标题',
      '',
      '作者: 作者A',
      '',
      'https://www.pixiv.net/novel/series/34567890',
      '',
      '更新日期: 2024-01-01',
      '',
      '正文内容',
    ].join('\n');
    expect(parsePixivNovelMetaHeader(content)).toEqual({
      title: '系列标题',
      author: '作者A',
      seriesId: '34567890',
    });
  });

  it('returns null when no pixiv URL is present', () => {
    expect(parsePixivNovelMetaHeader('标题\n\n作者A\n\n普通内容')).toBeNull();
  });
});
