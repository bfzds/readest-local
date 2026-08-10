import { useEffect, useState } from 'react';
import { BookMetadata } from '@/libs/document';
import {
  validateAndNormalizeDate,
  validateAndNormalizeLanguage,
  validateAndNormalizeSubjects,
  validateISBN,
  ValidationResult,
} from '@/utils/validation';

export const useMetadataEdit = (metadata: BookMetadata | null, tags: string[]) => {
  const [editedMeta, setEditedMeta] = useState<BookMetadata>({} as BookMetadata);
  const [editedTags, setEditedTags] = useState<string[]>(tags);
  const [fieldSources, setFieldSources] = useState<Record<string, string>>({});
  const [lockedFields, setLockedFields] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const lockableFields = [
    'title',
    'author',
    'isbn',
    'publisher',
    'published',
    'language',
    'identifier',
    'subject',
    'tags',
    'description',
    'subtitle',
    'series',
    'seriesIndex',
    'seriesTotal',
    'coverImageUrl',
  ];

  useEffect(() => {
    if (metadata) {
      setEditedMeta({ ...metadata });
    }
  }, [metadata]);

  useEffect(() => {
    setEditedTags([...tags]);
  }, [tags]);

  useEffect(() => {
    const initialLockedFields: Record<string, boolean> = {};
    lockableFields.forEach((field) => {
      initialLockedFields[field] = false;
    });
    setLockedFields(initialLockedFields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFieldChange = (field: string, value: string | undefined) => {
    if (lockedFields[field]) {
      return;
    }

    // Tags live on the book, not in the metadata document; they still edit
    // like Subjects — a separator-split string. Empty segments survive so a
    // just-typed comma is not swallowed by the value round-trip; they are
    // dropped at save time.
    if (field === 'tags') {
      setEditedTags(value ? value.split(/,|;|，|、/).map((tag) => tag.trim()) : []);
      return;
    }

    setEditedMeta((prevMeta) => {
      const newMeta = { ...prevMeta } as { [key: string]: unknown };
      switch (field) {
        case 'subject':
          newMeta['subject'] = value ? value.split(/,|;|，|、/).map((s) => s.trim()) : [];
          break;
        default:
          newMeta[field] = value;
      }
      return newMeta as BookMetadata;
    });

    if (value !== undefined) {
      handleFieldValidation(field, value);
    }

    if (fieldSources[field]) {
      setFieldSources((prevSources) => {
        const newSources = { ...prevSources };
        delete newSources[field];
        return newSources;
      });
    }
  };

  const handleFieldValidation = (field: string, value: string) => {
    if (lockedFields[field]) {
      return true;
    }

    let validationResult: ValidationResult<unknown>;
    switch (field) {
      case 'title':
      case 'author':
        if (!value.trim()) {
          console.warn(`Field ${field} cannot be empty`);
          setFieldErrors((prev) => ({ ...prev, [field]: 'This field is required' }));
          return false;
        }
        break;

      case 'published':
        if (value.trim()) {
          validationResult = validateAndNormalizeDate(value);
          if (!validationResult.isValid) {
            console.warn(`Invalid date for field ${field}:`, validationResult.error);
            setFieldErrors((prev) => ({ ...prev, [field]: validationResult.error || '' }));
            return false;
          }
        }
        break;

      case 'language':
        if (value.trim()) {
          validationResult = validateAndNormalizeLanguage(value);
          if (!validationResult.isValid) {
            console.warn(`Invalid language for field ${field}:`, validationResult.error);
            setFieldErrors((prev) => ({ ...prev, [field]: validationResult.error || '' }));
            return false;
          }
        }
        break;

      case 'subject':
        if (value.trim()) {
          validationResult = validateAndNormalizeSubjects(value);
          if (!validationResult.isValid) {
            console.warn(`Invalid subjects for field ${field}:`, validationResult.error);
            setFieldErrors((prev) => ({ ...prev, [field]: validationResult.error || '' }));
            return false;
          }
        }
        break;

      case 'isbn':
        if (value.trim()) {
          validationResult = validateISBN(value);
          if (!validationResult.isValid) {
            console.warn(`Invalid ISBN for field ${field}:`, validationResult.error);
            setFieldErrors((prev) => ({ ...prev, [field]: validationResult.error || '' }));
            return false;
          }
        }
        break;
    }

    setFieldErrors((prev) => {
      const newErrors = { ...prev };
      delete newErrors[field];
      return newErrors;
    });

    return true;
  };

  const handleToggleFieldLock = (field: string) => {
    setLockedFields((prev) => ({
      ...prev,
      [field]: !prev[field],
    }));
  };

  const handleLockAll = () => {
    const allLocked: Record<string, boolean> = {};
    lockableFields.forEach((field) => {
      allLocked[field] = true;
    });
    setLockedFields(allLocked);
  };

  const handleUnlockAll = () => {
    const allUnlocked: Record<string, boolean> = {};
    lockableFields.forEach((field) => {
      allUnlocked[field] = false;
    });
    setLockedFields(allUnlocked);
  };

  const resetToOriginal = () => {
    if (metadata) {
      setEditedMeta({ ...metadata });
    }
    setEditedTags([...tags]);
    setFieldSources({});
    setFieldErrors({});
    handleUnlockAll();
  };

  return {
    editedMeta,
    editedTags,
    fieldSources,
    lockedFields,
    fieldErrors,
    handleFieldChange,
    handleFieldValidation,
    handleToggleFieldLock,
    handleLockAll,
    handleUnlockAll,
    resetToOriginal,
  };
};
