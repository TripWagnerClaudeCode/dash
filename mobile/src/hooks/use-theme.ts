import { Colors, type Palette } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme(): Palette {
  return Colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
