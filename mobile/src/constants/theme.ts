/** iOS system colors, so the phone looks like the Mac app (which uses the macOS ones). */
export const Colors = {
  light: {
    text: '#000000',
    textSecondary: '#6C6C70',
    background: '#F2F2F7',
    card: '#FFFFFF',
    field: '#E9E9EB',
    separator: '#D1D1D6',
    accent: '#007AFF',
    green: '#34C759',
    orange: '#FF9500',
    red: '#FF3B30',
  },
  dark: {
    text: '#FFFFFF',
    textSecondary: '#98989F',
    background: '#000000',
    card: '#1C1C1E',
    field: '#2C2C2E',
    separator: '#38383A',
    accent: '#0A84FF',
    green: '#30D158',
    orange: '#FF9F0A',
    red: '#FF453A',
  },
} as const;

export type Palette = (typeof Colors)['light'] | (typeof Colors)['dark'];

/** Same steps as the Mac app's DS.Space. */
export const Spacing = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;
export const Radius = { control: 8, card: 12 } as const;
export const MaxContentWidth = 700;
