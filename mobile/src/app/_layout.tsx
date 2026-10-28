import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { HubProvider } from '@/lib/hub-context';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <HubProvider>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair with Dash' }} />
          <Stack.Screen name="chat/[id]" options={{ title: '' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings', headerBackTitle: 'Today' }} />
          <Stack.Screen name="memory" options={{ title: 'Memory', headerBackTitle: 'Settings' }} />
        </Stack>
      </HubProvider>
    </ThemeProvider>
  );
}
