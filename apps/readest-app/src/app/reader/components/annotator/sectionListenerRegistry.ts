// C-6 复核：section 文档与监听器 cleanup 的对应关系 registry。
// Annotator 以 section index 挂载监听器；section 替换/卸载时立即清理旧 doc，
// 同一 doc 重复 load 不重复注册，组件卸载时 disposeAll 幂等清理全部。
export interface SectionListenerRegistry {
  replace: (index: number, doc: Document, cleanup: () => void) => boolean;
  disposeDocument: (doc: Document) => void;
  disposeAll: () => void;
}

export const createSectionListenerRegistry = (): SectionListenerRegistry => {
  const cleanupByDoc = new WeakMap<Document, () => void>();
  const docByIndex = new Map<number, Document>();
  const activeCleanups = new Set<() => void>();

  const disposeDocument = (doc: Document) => {
    const cleanup = cleanupByDoc.get(doc);
    if (!cleanup) return;
    cleanupByDoc.delete(doc);
    activeCleanups.delete(cleanup);
    cleanup();
    for (const [index, current] of docByIndex) {
      if (current === doc) docByIndex.delete(index);
    }
  };

  return {
    replace(index, doc, cleanup) {
      if (cleanupByDoc.has(doc)) return false;
      const previous = docByIndex.get(index);
      if (previous && previous !== doc) disposeDocument(previous);
      let disposed = false;
      const once = () => {
        if (disposed) return;
        disposed = true;
        cleanup();
      };
      cleanupByDoc.set(doc, once);
      activeCleanups.add(once);
      docByIndex.set(index, doc);
      return true;
    },
    disposeDocument,
    disposeAll() {
      for (const cleanup of [...activeCleanups]) cleanup();
      activeCleanups.clear();
      docByIndex.clear();
    },
  };
};
