import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * The pairing token lives in the iPhone's Keychain (SecureStore). SecureStore has no web version, so
 * the browser build, which is only used to test the app on the Mac, keeps it in localStorage.
 */
export const secureStorage = {
  get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return Promise.resolve(globalThis.localStorage?.getItem(key) ?? null);
    return SecureStore.getItemAsync(key);
  },
  set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.setItem(key, value);
      return Promise.resolve();
    }
    return SecureStore.setItemAsync(key, value);
  },
  remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.removeItem(key);
      return Promise.resolve();
    }
    return SecureStore.deleteItemAsync(key);
  },
};
