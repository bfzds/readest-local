/**
 * 会话内章节解压文本缓存：按解压后文本字节预算（UTF-16 估算）做 LRU。
 * 翻回旧章时命中已解压的 HTML 字符串，避免重复 inflate。随所属 bookDoc
 * 的闭包生命周期自动回收，无需显式清空。
 */
export class ChapterTextCache {
  private map = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(name: string): string | undefined {
    const value = this.map.get(name);
    if (value !== undefined) {
      // 命中即提升为最近使用
      this.map.delete(name);
      this.map.set(name, value);
    }
    return value;
  }

  set(name: string, text: string): void {
    const prev = this.map.get(name);
    if (prev !== undefined) {
      this.bytes -= prev.length * 2;
    }
    this.bytes += text.length * 2;
    this.map.set(name, text);
    this.evict();
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  private evict(): void {
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const oldestName = this.map.keys().next().value;
      if (oldestName === undefined) break;
      const oldest = this.map.get(oldestName);
      if (oldest !== undefined) {
        this.bytes -= oldest.length * 2;
      }
      this.map.delete(oldestName);
    }
  }
}
