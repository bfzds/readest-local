import React from 'react';
import { RiQuillPenLine } from 'react-icons/ri';

import { useSidebarStore } from '@/store/sidebarStore';
import { useNotebookStore } from '@/store/notebookStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import Button from '@/components/Button';

interface NotebookTogglerProps {
  bookKey: string;
}

const NotebookToggler: React.FC<NotebookTogglerProps> = ({ bookKey }) => {
  const _ = useTranslation();
  const { sideBarBookKey, setSideBarBookKey } = useSidebarStore();
  const { isNotebookVisible, toggleNotebook } = useNotebookStore();
  const iconSize18 = useResponsiveSize(18);

  const handleToggleSidebar = () => {
    if (sideBarBookKey === bookKey) {
      toggleNotebook();
    } else {
      setSideBarBookKey(bookKey);
      if (!isNotebookVisible) toggleNotebook();
    }
  };
  return (
    <Button
      icon={
        sideBarBookKey == bookKey && isNotebookVisible ? (
          <RiQuillPenLine size={iconSize18} className='text-base-content' />
        ) : (
          <RiQuillPenLine size={iconSize18} className='text-base-content' />
        )
      }
      onClick={handleToggleSidebar}
      label={_('Notebook')}
    ></Button>
  );
};

export default NotebookToggler;
