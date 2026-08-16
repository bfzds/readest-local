import { createCoverThumbnailCache } from './coverThumbnailCache';

// 书库网格封面显示宽度通常 ≤ 512px，源封面常是书内原图（可能 2000px+）。
// 若直接渲染，浏览器按原图全尺寸解码位图常驻内存。这里用 createImageBitmap
// 在解码时缩放到目标尺寸（不经 canvas，规避跨域污染；WebView2 支持）。
// 失败（非图片 / SVG 等 createImageBitmap 不支持的源）回退原 URL。
const MAX_THUMB_WIDTH = 512;
const THUMBNAIL_JPEG_QUALITY = 0.85;

const bitmapToObjectUrl = (bitmap: ImageBitmap): Promise<string | null> =>
  new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.drawImage(bitmap, 0, 0);
    canvas.toBlob(
      (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
      'image/jpeg',
      THUMBNAIL_JPEG_QUALITY,
    );
  });

const createThumbnail = async (src: string): Promise<string | null> => {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    const meta = await createImageBitmap(blob);
    const ratio = Math.min(1, MAX_THUMB_WIDTH / meta.width);
    const width = Math.max(1, Math.round(meta.width * ratio));
    const height = Math.max(1, Math.round(meta.height * ratio));
    meta.close();
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'low',
    });
    try {
      return await bitmapToObjectUrl(bitmap);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
};

export const getCoverThumbnailUrl = createCoverThumbnailCache(createThumbnail, {}, (url) =>
  URL.revokeObjectURL(url),
);
