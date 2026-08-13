import React from 'react';
import { useRouter } from 'next/navigation';
import { MdChevronRight } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { navigateToLibrary } from '@/utils/nav';
import { LibraryGroupByType } from '@/types/settings';

interface GroupHeaderProps {
  groupBy: LibraryGroupByType;
  groupName: string;
}

/**
 * Header component displayed when viewing books inside a virtual group.
 * Shows the group type, group name, and a back button to return to the main bookshelf.
 */
const GroupHeader: React.FC<GroupHeaderProps> = ({ groupBy, groupName }) => {
  const _ = useTranslation();
  const router = useRouter();
  const iconSize = useResponsiveSize(20);

  const handleBack = () => {
    const params = new URLSearchParams(window.location.search);
    // Set `group` to an empty string instead of deleting it. After a cold start
    // the URL inside a series/author folder is just `?group=X` (groupBy comes
    // from settings, not the URL), so deleting `group` would leave an empty
    // search string — and `router.replace('/library')` with an empty search
    // silently no-ops under the Next.js 16.2 static export, leaving the back
    // button dead (#4437). This mirrors the workaround in
    // `handleLibraryNavigation` (see page.tsx, originally #3782/#3832): the
    // resulting `/library?group=` does commit, and the trailing empty `group=`
    // is stripped cosmetically by the cleanup effect in page.tsx.
    params.set('group', '');
    // Carry this virtual dimension so "back" lands on the dimension's top-level
    // list (e.g. the author list), not the library home page in whatever
    // dimension the top level happens to remember.
    params.set('groupBy', groupBy);
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
