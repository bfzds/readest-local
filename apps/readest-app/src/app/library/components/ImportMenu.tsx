import clsx from 'clsx';
import { IoFileTray } from 'react-icons/io5';
import { MdFolderSpecial } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import MenuItem from '@/components/MenuItem';
import Menu from '@/components/Menu';

export interface ImportMenuProps {
  menuClassName?: string;
  setIsDropdownOpen?: (open: boolean) => void;
  onImportBooksFromFiles: () => void;
  onImportBooksFromDirectory?: () => void;
  /**
   * Open the manage-watched-folders dialog. Omitted where watching folders is
   * not supported (e.g. the web build, which has no external directories).
   */
  onManageWatchedFolders?: () => void;
}

const ImportMenu: React.FC<ImportMenuProps> = ({
  menuClassName,
  setIsDropdownOpen,
  onImportBooksFromFiles,
  onImportBooksFromDirectory,
  onManageWatchedFolders,
}) => {
  const _ = useTranslation();

  const handleImportFromFiles = () => {
    onImportBooksFromFiles();
    setIsDropdownOpen?.(false);
  };

  const handleImportFromDirectory = () => {
    onImportBooksFromDirectory?.();
    setIsDropdownOpen?.(false);
  };

  const handleManageWatchedFolders = () => {
    onManageWatchedFolders?.();
    setIsDropdownOpen?.(false);
  };

  return (
    <Menu
      className={clsx(
        'dropdown-content bg-base-100 rounded-box !relative z-[1] mt-3 p-2 shadow',
        menuClassName,
      )}
      onCancel={() => setIsDropdownOpen?.(false)}
    >
      <MenuItem
        label={_('From Local File')}
        Icon={<IoFileTray className='h-5 w-5' />}
        onClick={handleImportFromFiles}
      />
      {onImportBooksFromDirectory && (
        <MenuItem
          label={_('From Directory')}
          Icon={<IoFileTray className='h-5 w-5' />}
          onClick={handleImportFromDirectory}
        />
      )}
      {onManageWatchedFolders && (
        <MenuItem
          label={_('Watched Folders')}
          Icon={<MdFolderSpecial className='h-5 w-5' />}
          onClick={handleManageWatchedFolders}
        />
      )}
    </Menu>
  );
};

export default ImportMenu;
