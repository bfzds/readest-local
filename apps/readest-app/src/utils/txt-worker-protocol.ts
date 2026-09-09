export interface TxtConverterWorkerRequest {
  type: 'convert';
  payload: {
    file: File;
    author?: string;
    language?: string;
    /** 用户自定义章节标题正则（方向③），透传至 TxtToEpubConverter。 */
    chapterPatterns?: string[];
  };
}

export interface TxtConverterWorkerSuccess {
  type: 'success';
  payload: {
    epubBuffer: ArrayBuffer;
    name: string;
    bookTitle: string;
    chapterCount: number;
    language: string;
    /** 规则一条都没匹配上、章节由段落兜底切出时为 true（见 ConversionResult）。 */
    usedFallback: boolean;
  };
}

export interface TxtConverterWorkerError {
  type: 'error';
  payload: {
    message: string;
  };
}

export type TxtConverterWorkerResponse = TxtConverterWorkerSuccess | TxtConverterWorkerError;
