// 「从正文生成目录」的对话框骨架（Task 6 只接线，Task 7 实现扫描/合成与写入流程）。
import type { BookDoc } from '@/libs/document';

const VirtualTocDialog: React.FC<{
  bookKey: string;
  bookDoc: BookDoc;
  onClose: () => void;
}> = () => null;

export default VirtualTocDialog;
