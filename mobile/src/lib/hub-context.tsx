import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import {
  HubClient,
  pairOnce,
  type ConnectionState,
  type Credentials,
  type DeadlinesSnapshot,
  type HealthSnapshot,
  type LectureSnapshot,
  type TodaySnapshot,
  type TodoSnapshot,
  type UsageSnapshot,
} from '@/lib/hub';
import { secureStorage } from '@/lib/storage';

const CREDENTIALS_KEY = 'dash.hub.credentials';

/** The last data the hub sent, so the app has something to show when the hub can't be reached. */
function cacheFile(): File | undefined {
  try {
    return new File(Paths.document, 'dash-hub-copies.json');
  } catch {
    return undefined; // the browser build has no file system
  }
}

type HubContext = {
  client: HubClient;
  /** False until the saved pairing has been read, so screens don't flash "not paired". */
  ready: boolean;
  state: ConnectionState;
  problem?: string;
  mac?: string;
  today?: TodaySnapshot;
  todo?: TodoSnapshot;
  usage?: UsageSnapshot;
  lecture?: LectureSnapshot;
  health?: HealthSnapshot;
  deadlines?: DeadlinesSnapshot;
  /** When the saved copies were last updated, for "showing data from 12:41" while offline. */
  savedAt?: string;
  pair: (url: string, code: string) => Promise<void>;
  unpair: () => Promise<void>;
};

const Context = createContext<HubContext | null>(null);

export function HubProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => new HubClient(), []);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ConnectionState>(client.state);
  const [problem, setProblem] = useState<string>();
  const [mac, setMac] = useState<string>();
  const [today, setToday] = useState<TodaySnapshot>();
  const [todo, setTodo] = useState<TodoSnapshot>();
  const [usage, setUsage] = useState<UsageSnapshot>();
  const [lecture, setLecture] = useState<LectureSnapshot>();
  const [health, setHealth] = useState<HealthSnapshot>();
  const [deadlines, setDeadlines] = useState<DeadlinesSnapshot>();
  const [savedAt, setSavedAt] = useState<string>();
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** Drops everything this phone kept from the hub: the screens' data, the saved copies, and a save still pending. */
  const clearLocal = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    setMac(undefined);
    setToday(undefined);
    setTodo(undefined);
    setUsage(undefined);
    setLecture(undefined);
    setHealth(undefined);
    setDeadlines(undefined);
    setSavedAt(undefined);
    client.forget();
    try {
      cacheFile()?.delete();
    } catch {}
  }, [client]);

  useEffect(() => {
    const stops = [
      client.onStateChange(() => {
        setState(client.state);
        setProblem(client.problem);
      }),
      client.on('today', setToday),
      client.on('todo', setTodo),
      client.on('usage', setUsage),
      client.on('lecture', setLecture),
      client.on('health', setHealth),
      client.on('deadlines', setDeadlines),
      client.onRevoke(() => {
        secureStorage.remove(CREDENTIALS_KEY);
        clearLocal();
      }),
    ];
    // Saved copies first, so screens aren't blank while connecting (or when the hub is down).
    const file = cacheFile();
    if (file?.exists) {
      file.text().then((text) => {
        const saved = JSON.parse(text);
        client.seed(saved.events ?? {});
        setSavedAt(saved.savedAt);
      }).catch(() => {});
    }
    stops.push(client.onEvent(() => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = undefined;
        const stamp = new Date().toISOString();
        file?.write(JSON.stringify({ savedAt: stamp, events: client.copies() })).then(() => setSavedAt(stamp)).catch(() => {});
      }, 3000);
    }));
    secureStorage.get(CREDENTIALS_KEY)
      .then((saved) => {
        if (!saved) return;
        const credentials: Credentials = JSON.parse(saved);
        setMac(credentials.mac);
        client.connect(credentials);
      })
      .catch(() => {})
      .finally(() => setReady(true));
    // Coming back to the app checks the connection right away (ping if online, reconnect if not) instead of
    // waiting out the backoff; the heartbeat pauses in the background. "inactive" (Control Center, a call) is ignored.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') client.setForeground(true);
      else if (next === 'background') client.setForeground(false);
    });
    return () => {
      stops.forEach((stop) => stop());
      appState.remove();
      clearTimeout(saveTimer.current);
      client.disconnect();
    };
  }, [client, clearLocal]);

  const value: HubContext = {
    client,
    ready,
    state,
    problem,
    mac,
    today,
    todo,
    usage,
    lecture,
    health,
    deadlines,
    savedAt,
    async pair(url, code) {
      const name = Device.deviceName ?? Device.modelName ?? 'iPhone';
      const credentials = await pairOnce(url.trim(), code.trim(), name);
      await secureStorage.set(CREDENTIALS_KEY, JSON.stringify(credentials));
      setMac(credentials.mac);
      client.connect(credentials);
    },
    async unpair() {
      await secureStorage.remove(CREDENTIALS_KEY);
      client.disconnect();
      clearLocal();
    },
  };

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useHub(): HubContext {
  const context = useContext(Context);
  if (!context) throw new Error('useHub must be used inside HubProvider');
  return context;
}
