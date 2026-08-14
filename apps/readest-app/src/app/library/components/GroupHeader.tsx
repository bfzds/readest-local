import React from 'react';
import { useRouter } from 'next/navigation';
import { MdChevronRight } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { navigateToLibrary } from '@/utils/nav';

interface GroupHeaderProps {
  groupName: string;
}

/**
 * 虚拟分组（作者/系列/标签/主题）内的导航头：显示组名与"全部"返回按钮。
 * 返回目标是进入时的来源（URL `from` 参数 —— 一个文件夹，或顶层），而不是
 * 一律回顶层：文件夹内打开的作者分组必须能退回到那个文件夹。
 */
const GroupHeader: React.FC<GroupHeaderProps> = ({ groupName }) => {
  const _ = useTranslation();
  const router = useRouter();
  const iconSize = useResponsiveSize(20);

  const handleBack = () => {
    const params = new URLSearchParams(window.location.search);
    // 回到进入时的来源：`from` 记录来源 group（文件夹 id 或空 = 顶层）。
    // 文件夹内打开的虚拟分组必须退回该文件夹，而不是全库首页。
    const fromGroup = params.get('from');
    // 用 `group=` 而非删掉 group 参数：无 `from`（来源顶层）时 group 置空字符串，
    // 保证 query 非空 —— Next.js 16.2 静态导出下 `router.replace('/library')`
    // （空 search）会静默 no-op，返回按钮失效（#4437，同 #3782 根因）。空 `group=`
    // 由 page.tsx 的清理 effect 在导航提交后 cosmetically 移除。
    params.set('group', fromGroup ?? '');
    params.delete('from');
    // 来源视图用自身 per-group 记忆（groupByByGroup）解析分组维度，删掉 URL 的
    // groupBy override，避免把虚拟维度强加到来源视图上。
    params.delete('groupBy');
    navigateToLibrary(router, params.toString());
  };

  return (
    <div className='flex items-center gap-0.5 px-4 py-2'>
      <button
        onClick={handleBack}
        className='hover:bg-base-300 text-base-content/85 truncate rounded px-2 py-1'
      >
        {_('All')}
      </button>
      <MdChevronRight size={iconSize} className='text-neutral-content shrink-0' />
      <span className='text-base-content truncate rounded px-2 py-1 font-medium'>{groupName}</span>
    </div>
  );
};

export default GroupHeader;
