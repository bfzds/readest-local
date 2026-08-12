import { AppService } from '@/types/system';
import { SelectedFile } from '@/hooks/useFileSelector';

/**
 * Consume book files picked through the native-bridge file picker on Android.
 *
 * The Tauri dialog plugin's picker resolves a JS promise with the result, but
 * that promise dies whenever Android tears down the activity or process while
 * the system picker is in the foreground (low-RAM devices, FireOS — #1217).
 * The native-bridge picker instead delivers results as a `file-picker-result`
 * plugin event routed through the same pending-event queue as shared intents.
 *
 * The app no longer targets Android, so no bridge listener is ever registered.
 */
export function useAndroidPickedBooks(
  _appService: AppService | null,
  _onPickedBooks: (files: SelectedFile[]) => void,
) {
  // No-op on desktop: the native-bridge file picker is Android-only.
}
