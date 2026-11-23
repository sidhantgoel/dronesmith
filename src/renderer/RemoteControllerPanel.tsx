import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { RcInfo, RcPackage } from '../types';
import { AlertIcon } from './icons';
import { Btn, Chip, Overline, PageHeader, Panel } from './ui';

type TabKey = 'overview' | 'apps' | 'install' | 'shell' | 'launcher' | 'files' | 'settings' | 'hacks' | 'mirror';

const TAB_LABELS: Record<TabKey, string> = {
  overview: 'Overview',
  apps: 'Apps',
  install: 'Install',
  shell: 'Root shell',
  launcher: 'Launcher',
  files: 'Files',
  settings: 'Settings',
  hacks: 'Hacks',
  mirror: 'Screen',
};

const TABS: TabKey[] = ['overview', 'apps', 'install', 'shell', 'launcher', 'files', 'settings', 'hacks', 'mirror'];

/** Curated, reversible Android tweaks for the Hacks tab. */
const HACKS: { label: string; description: string; command: string }[] = [
  {
    label: 'Stay awake while charging',
    description: 'Keeps the screen on while the controller is powered.',
    command: 'settings put global stay_on_while_plugged_in 3',
  },
  {
    label: 'Disable animations',
    description: 'Sets window / transition / animator scale to 0 for a snappier UI.',
    command:
      'settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0',
  },
  {
    label: 'Restore animations',
    description: 'Sets the three animation scales back to 1.',
    command:
      'settings put global window_animation_scale 1; settings put global transition_animation_scale 1; settings put global animator_duration_scale 1',
  },
  {
    label: 'Show touches',
    description: 'Draws a dot where the screen is touched (useful for demos).',
    command: 'settings put system show_touches 1',
  },
  {
    label: 'Hide touches',
    description: 'Turns the touch indicator back off.',
    command: 'settings put system show_touches 0',
  },
];

function Mono({ children }: { children: string }) {
  return (
    <Box
      as="pre"
      className="selectable"
      mt="8px"
      p="10px"
      maxH="260px"
      overflow="auto"
      bg="bg.raised"
      borderWidth="1px"
      borderColor="border"
      borderRadius="8px"
      fontFamily="mono"
      fontSize="11px"
      color="fg.muted"
      whiteSpace="pre-wrap"
      wordBreak="break-word"
    >
      {children}
    </Box>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  w,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  w?: string;
}) {
  return (
    <Box w={w}>
      <Text fontSize="10px" color="fg.subtle" mb="3px">
        {label}
      </Text>
      <chakra.input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        w="full"
        h="30px"
        px="9px"
        fontFamily="mono"
        fontSize="12px"
        bg="bg.raised"
        borderWidth="1px"
        borderColor="border.strong"
        borderRadius="7px"
        color="fg"
        _placeholder={{ color: 'fg.subtle' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
      />
    </Box>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Flex as="label" align="center" gap="7px" cursor="pointer" fontSize="12px" color="fg.muted">
      <chakra.input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        w="14px"
        h="14px"
        accentColor="var(--chakra-colors-accent)"
      />
      {label}
    </Flex>
  );
}

function InfoGrid({ info }: { info: RcInfo }) {
  const rows: [string, string][] = [
    ['Model', info.model || '—'],
    ['Serial', info.serial],
    ['Firmware', info.firmware || '—'],
    ['Android', info.android ? `${info.android} (SDK ${info.sdk})` : '—'],
    ['Battery', info.battery ? `${info.battery}%` : '—'],
    ['Root', info.root ? 'yes' : 'no'],
  ];
  return (
    <Box display="grid" gridTemplateColumns="repeat(2, 1fr)" gap="8px 20px">
      {rows.map(([k, v]) => (
        <Flex key={k} justify="space-between" gap="10px" borderBottomWidth="1px" borderColor="border" pb="5px">
          <Text fontSize="11.5px" color="fg.subtle">
            {k}
          </Text>
          <Text className="selectable" fontFamily="mono" fontSize="11.5px" color="fg" truncate title={v}>
            {v}
          </Text>
        </Flex>
      ))}
    </Box>
  );
}

function RemoteControllerPanel() {
  const [info, setInfo] = useState<RcInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');
  const [busy, setBusy] = useState(false);
  const serial = info?.serial ?? '';

  const connect = async (): Promise<void> => {
    setConnecting(true);
    setError(null);
    try {
      const result = await window.rc.connect();
      if (result.ok && result.info) {
        setInfo(result.info);
      } else {
        setInfo(null);
        setError(result.error ?? 'Could not connect to a remote controller.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    await window.rc.disconnect();
    setInfo(null);
    setError(null);
  };

  return (
    <Box>
      <PageHeader
        title="Remote controller"
        subtitle="ADB service tools for DJI smart controllers (RC, RC 2, RC Pro, RC Plus) over USB."
        actions={
          info ? (
            <Flex gap="8px">
              <Btn onClick={() => void window.rc.info(serial).then(setInfo)}>Refresh</Btn>
              <Btn onClick={() => void disconnect()}>Disconnect</Btn>
            </Flex>
          ) : (
            <Btn variant="primary" disabled={connecting} onClick={() => void connect()}>
              {connecting ? 'Connecting…' : 'Connect'}
            </Btn>
          )
        }
      />

      {!info && (
        <Panel px="18px" py="16px">
          <Text fontSize="12.5px" color="fg.muted">
            Connect a DJI smart controller over USB with its screen on and <b>USB debugging</b> enabled (Settings →
            system → developer options). Accept the “Allow USB debugging” prompt on the controller, then press Connect.
          </Text>
          {error && (
            <Flex align="center" gap="8px" mt="12px" color="danger">
              <AlertIcon size={15} />
              <Text fontSize="12.5px">{error}</Text>
            </Flex>
          )}
        </Panel>
      )}

      {info && (
        <>
          <Flex align="center" gap="10px" mb="12px">
            <Chip tone="ok">Connected</Chip>
            <Text fontSize="12.5px" color="fg.muted" fontFamily="mono">
              {info.model || info.serial}
            </Text>
            {info.root && <Chip tone="accent">root</Chip>}
          </Flex>

          <Flex
            gap="4px"
            mb="14px"
            p="3px"
            bg="bg.raised"
            borderRadius="10px"
            borderWidth="1px"
            borderColor="border"
            wrap="wrap"
          >
            {TABS.map((t) => (
              <chakra.button
                key={t}
                onClick={() => setTab(t)}
                px="12px"
                h="30px"
                fontSize="12.5px"
                fontWeight={t === tab ? '600' : '500'}
                borderRadius="7px"
                bg={t === tab ? 'bg.surface' : 'transparent'}
                color={t === tab ? 'fg' : 'fg.muted'}
                borderWidth="1px"
                borderColor={t === tab ? 'border.strong' : 'transparent'}
                _hover={{ color: 'fg' }}
                _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
              >
                {TAB_LABELS[t]}
              </chakra.button>
            ))}
          </Flex>

          {error && (
            <Flex align="center" gap="8px" mb="12px" color="danger">
              <AlertIcon size={15} />
              <Text fontSize="12.5px">{error}</Text>
            </Flex>
          )}

          {tab === 'overview' && (
            <Panel px="18px" py="16px">
              <Overline>Device</Overline>
              <Box mt="12px">
                <InfoGrid info={info} />
              </Box>
              <Flex gap="8px" mt="14px">
                <Btn
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const r = await window.rc.root(serial);
                    setBusy(false);
                    setError(r.root ? null : `Root not available: ${r.message || 'denied'}`);
                    await window.rc.info(serial).then(setInfo);
                  }}
                >
                  Try root
                </Btn>
              </Flex>
            </Panel>
          )}

          {tab === 'apps' && <AppsTab serial={serial} setError={setError} />}
          {tab === 'install' && <InstallTab serial={serial} />}
          {tab === 'shell' && <ShellTab serial={serial} />}
          {tab === 'launcher' && <LauncherTab serial={serial} setError={setError} />}
          {tab === 'files' && <FilesTab serial={serial} />}
          {tab === 'settings' && <SettingsTab serial={serial} />}
          {tab === 'hacks' && <HacksTab serial={serial} />}
          {tab === 'mirror' && <MirrorTab serial={serial} />}
        </>
      )}
    </Box>
  );
}

// ── Apps ─────────────────────────────────────────────────────────────────────

function AppsTab({ serial, setError }: { serial: string; setError: (e: string | null) => void }) {
  const [pkgs, setPkgs] = useState<RcPackage[]>([]);
  const [thirdOnly, setThirdOnly] = useState(true);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [out, setOut] = useState<string>('');

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      setPkgs(await window.rc.packages(serial, thirdOnly));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [serial, thirdOnly]);

  const act = async (pkg: string, action: 'launch' | 'force-stop' | 'enable' | 'disable' | 'clear'): Promise<void> => {
    const r = await window.rc.appAction(serial, pkg, action);
    setOut(`${action} ${pkg}\n${r.output}`);
    if (!r.ok) setError(`${action} failed on ${pkg}`);
  };

  const uninstall = async (pkg: string): Promise<void> => {
    setConfirm(null);
    const r = await window.rc.uninstall(serial, pkg);
    setOut(`uninstall ${pkg}\n${r.output}`);
    if (r.ok) setPkgs((list) => list.filter((p) => p.pkg !== pkg));
  };

  const pullApk = async (pkg: string): Promise<void> => {
    const dir = await window.rc.pickFolder();
    if (!dir) return;
    const [res] = await window.rc.pullApks(serial, [pkg], dir);
    setOut(res.ok ? `Pulled ${pkg} → ${res.file}` : `Pull failed: ${res.error ?? ''}`);
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? pkgs.filter((p) => p.pkg.toLowerCase().includes(q)) : pkgs;
  }, [pkgs, filter]);

  return (
    <Panel px="16px" py="14px">
      <Flex align="center" gap="12px" wrap="wrap" mb="10px">
        <Check checked={thirdOnly} onChange={setThirdOnly} label="Third-party only" />
        <Btn onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Btn>
        <chakra.input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter packages…"
          flex="1"
          minW="180px"
          h="30px"
          px="10px"
          fontSize="12px"
          bg="bg.raised"
          borderWidth="1px"
          borderColor="border.strong"
          borderRadius="7px"
          color="fg"
          _placeholder={{ color: 'fg.subtle' }}
        />
        <Text fontSize="11px" color="fg.subtle">
          {shown.length} packages
        </Text>
      </Flex>

      <Box maxH="calc(100vh - 380px)" overflowY="auto" borderWidth="1px" borderColor="border" borderRadius="8px">
        {shown.map((p) => (
          <Box key={p.pkg} px="12px" py="7px" borderBottomWidth="1px" borderColor="border" _hover={{ bg: 'bg.hover' }}>
            <Flex align="center" gap="8px">
              <Text flex="1" fontFamily="mono" fontSize="11.5px" truncate title={p.apkPath}>
                {p.pkg}
              </Text>
              {p.system && <Chip tone="warn">system</Chip>}
            </Flex>
            <Flex gap="6px" mt="6px" wrap="wrap">
              <Btn onClick={() => void act(p.pkg, 'launch')}>Launch</Btn>
              <Btn onClick={() => void act(p.pkg, 'force-stop')}>Stop</Btn>
              <Btn onClick={() => void act(p.pkg, 'disable')}>Disable</Btn>
              <Btn onClick={() => void act(p.pkg, 'enable')}>Enable</Btn>
              <Btn onClick={() => void act(p.pkg, 'clear')}>Clear data</Btn>
              <Btn onClick={() => void pullApk(p.pkg)}>Pull APK</Btn>
              <Btn onClick={() => setConfirm(p.pkg)}>Uninstall</Btn>
            </Flex>
            {confirm === p.pkg && (
              <Flex align="center" gap="8px" mt="6px">
                <Text fontSize="11.5px" color="danger">
                  Uninstall {p.pkg}?
                </Text>
                <Btn onClick={() => void uninstall(p.pkg)}>Yes, uninstall</Btn>
                <Btn onClick={() => setConfirm(null)}>Cancel</Btn>
              </Flex>
            )}
          </Box>
        ))}
        {shown.length === 0 && (
          <Text fontSize="12px" color="fg.subtle" px="12px" py="12px">
            {loading ? 'Loading…' : 'No packages.'}
          </Text>
        )}
      </Box>
      {out && <Mono>{out}</Mono>}
    </Panel>
  );
}

// ── Install ──────────────────────────────────────────────────────────────────

function InstallTab({ serial }: { serial: string }) {
  const [grant, setGrant] = useState(true);
  const [downgrade, setDowngrade] = useState(false);
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);

  const install = async (): Promise<void> => {
    const files = await window.rc.pickApk();
    if (!files || files.length === 0) return;
    setBusy(true);
    const lines: string[] = [];
    for (const file of files) {
      const name = file.split(/[\\/]/).pop() ?? file;
      const r = await window.rc.install(serial, file, grant, downgrade);
      lines.push(`${r.ok ? '✓' : '✗'} ${name}\n${r.output}`);
      setOut(lines.join('\n\n'));
    }
    setBusy(false);
  };

  return (
    <Panel px="18px" py="16px">
      <Overline>Install APK</Overline>
      <Flex gap="18px" mt="12px" mb="12px" wrap="wrap">
        <Check checked={grant} onChange={setGrant} label="Grant runtime permissions (-g)" />
        <Check checked={downgrade} onChange={setDowngrade} label="Allow version downgrade (-d)" />
      </Flex>
      <Btn variant="primary" disabled={busy} onClick={() => void install()}>
        {busy ? 'Installing…' : 'Select APK(s) and install'}
      </Btn>
      {out && <Mono>{out}</Mono>}
    </Panel>
  );
}

// ── Root shell ───────────────────────────────────────────────────────────────

function ShellTab({ serial }: { serial: string }) {
  const [cmd, setCmd] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);

  const run = async (): Promise<void> => {
    const c = cmd.trim();
    if (!c) return;
    history.current.push(c);
    setBusy(true);
    const r = await window.rc.shell(serial, c);
    setBusy(false);
    setOut(`$ ${c}\n${r.output}`);
  };

  return (
    <Panel px="18px" py="16px">
      <Overline>Shell</Overline>
      <Text fontSize="11.5px" color="fg.muted" mt="4px" mb="10px">
        Runs <code>adb shell &lt;command&gt;</code> on the controller. Use “Try root” on the Overview tab first if a
        command needs root.
      </Text>
      <Flex gap="8px">
        <chakra.input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
          placeholder="e.g. getprop ro.build.version.release"
          flex="1"
          h="32px"
          px="10px"
          fontFamily="mono"
          fontSize="12px"
          bg="bg.raised"
          borderWidth="1px"
          borderColor="border.strong"
          borderRadius="7px"
          color="fg"
          _placeholder={{ color: 'fg.subtle' }}
        />
        <Btn variant="primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Running…' : 'Run'}
        </Btn>
      </Flex>
      {out && <Mono>{out}</Mono>}
    </Panel>
  );
}

// ── Launcher ─────────────────────────────────────────────────────────────────

function LauncherTab({ serial, setError }: { serial: string; setError: (e: string | null) => void }) {
  const [launchers, setLaunchers] = useState<string[]>([]);
  const [out, setOut] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    setLaunchers(await window.rc.launchers(serial));
  };

  useEffect(() => {
    void refresh();
  }, [serial]);

  const setHome = async (component: string): Promise<void> => {
    setConfirm(null);
    const r = await window.rc.setHome(serial, component);
    setOut(`set-home ${component}\n${r.output}`);
    if (!r.ok) setError(`Could not set ${component} as home.`);
  };

  return (
    <Panel px="18px" py="16px">
      <Flex align="center" justify="space-between">
        <Overline>Home / launcher</Overline>
        <Btn onClick={() => void refresh()}>Refresh</Btn>
      </Flex>
      <Text fontSize="11.5px" color="fg.muted" mt="6px" mb="10px">
        Activities that can act as the Android home screen. Setting a third-party launcher replaces the DJI home —
        keep the DJI launcher in the list so you can switch back.
      </Text>
      <Flex direction="column" gap="6px">
        {launchers.map((c) => (
          <Flex key={c} align="center" gap="8px" borderBottomWidth="1px" borderColor="border" pb="6px">
            <Text flex="1" fontFamily="mono" fontSize="11.5px" truncate title={c}>
              {c}
            </Text>
            {confirm === c ? (
              <>
                <Btn onClick={() => void setHome(c)}>Confirm</Btn>
                <Btn onClick={() => setConfirm(null)}>Cancel</Btn>
              </>
            ) : (
              <Btn onClick={() => setConfirm(c)}>Set as home</Btn>
            )}
          </Flex>
        ))}
        {launchers.length === 0 && (
          <Text fontSize="12px" color="fg.subtle">
            No home activities found.
          </Text>
        )}
      </Flex>
      {out && <Mono>{out}</Mono>}
    </Panel>
  );
}

// ── Files ────────────────────────────────────────────────────────────────────

function FilesTab({ serial }: { serial: string }) {
  const [dir, setDir] = useState('/sdcard');
  const [remote, setRemote] = useState('/sdcard/');
  const [out, setOut] = useState('');

  return (
    <Panel px="18px" py="16px">
      <Overline>Files</Overline>
      <Flex gap="8px" mt="12px" align="flex-end" wrap="wrap">
        <Field label="Directory to list" value={dir} onChange={setDir} w="320px" />
        <Btn
          onClick={async () => {
            const r = await window.rc.ls(serial, dir);
            setOut(r.output);
          }}
        >
          List
        </Btn>
      </Flex>
      <Flex gap="8px" mt="14px" align="flex-end" wrap="wrap">
        <Field label="Remote path to pull (file)" value={remote} onChange={setRemote} w="320px" placeholder="/sdcard/DCIM/x.jpg" />
        <Btn
          onClick={async () => {
            const r = await window.rc.pull(serial, remote);
            setOut(r.ok ? `Pulled → ${r.file}` : r.output);
          }}
        >
          Pull file…
        </Btn>
        <Btn
          onClick={async () => {
            const r = await window.rc.push(serial, remote.replace(/[^/]*$/, '') || '/sdcard/');
            setOut(r.output);
          }}
        >
          Push file here…
        </Btn>
      </Flex>
      {out && <Mono>{out}</Mono>}
    </Panel>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

function SettingsTab({ serial }: { serial: string }) {
  const [ns, setNs] = useState('system');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [out, setOut] = useState('');

  return (
    <Panel px="18px" py="16px">
      <Overline>Android settings</Overline>
      <Flex gap="8px" mt="12px" align="flex-end" wrap="wrap">
        <Box>
          <Text fontSize="10px" color="fg.subtle" mb="3px">
            Namespace
          </Text>
          <chakra.select
            value={ns}
            onChange={(e) => setNs(e.target.value)}
            h="30px"
            px="8px"
            fontSize="12px"
            bg="bg.raised"
            borderWidth="1px"
            borderColor="border.strong"
            borderRadius="7px"
            color="fg"
          >
            <option value="system">system</option>
            <option value="secure">secure</option>
            <option value="global">global</option>
          </chakra.select>
        </Box>
        <Field label="Key" value={key} onChange={setKey} w="220px" placeholder="screen_brightness" />
        <Btn
          onClick={async () => {
            const r = await window.rc.settingsGet(serial, ns, key);
            setOut(`get ${ns} ${key}\n${r.output}`);
          }}
        >
          Get
        </Btn>
      </Flex>
      <Flex gap="8px" mt="12px" align="flex-end" wrap="wrap">
        <Field label="Value to put" value={value} onChange={setValue} w="220px" />
        <Btn
          onClick={async () => {
            const r = await window.rc.settingsPut(serial, ns, key, value);
            setOut(`put ${ns} ${key} ${value}\n${r.output}`);
          }}
        >
          Put
        </Btn>
      </Flex>
      {out && <Mono>{out}</Mono>}
    </Panel>
  );
}

// ── Hacks ────────────────────────────────────────────────────────────────────

function HacksTab({ serial }: { serial: string }) {
  const [out, setOut] = useState('');
  const [confirm, setConfirm] = useState<number | null>(null);

  const run = async (i: number): Promise<void> => {
    setConfirm(null);
    const r = await window.rc.shell(serial, HACKS[i].command);
    setOut(`${HACKS[i].label}\n${r.output || '(no output)'}`);
  };

  return (
    <Panel px="18px" py="16px">
      <Overline>Tweaks</Overline>
      <Text fontSize="11.5px" color="fg.muted" mt="4px" mb="12px">
        Reversible Android settings tweaks. Each runs an <code>adb shell settings</code> command.
      </Text>
      <Flex direction="column" gap="8px">
        {HACKS.map((h, i) => (
          <Flex key={h.label} align="center" gap="10px" borderBottomWidth="1px" borderColor="border" pb="8px">
            <Box flex="1">
              <Text fontSize="12.5px" color="fg">
                {h.label}
              </Text>
              <Text fontSize="11px" color="fg.subtle">
                {h.description}
              </Text>
            </Box>
            {confirm === i ? (
              <>
                <Btn onClick={() => void run(i)}>Run</Btn>
                <Btn onClick={() => setConfirm(null)}>Cancel</Btn>
              </>
            ) : (
              <Btn onClick={() => setConfirm(i)}>Apply</Btn>
            )}
          </Flex>
        ))}
      </Flex>
      {out && <Mono>{out}</Mono>}
    </Panel>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

/** Shortest gap between two captures while the live view runs. */
const SCREEN_INTERVAL_MS = 400;

function MirrorTab({ serial }: { serial: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const capture = async (): Promise<boolean> => {
    const shot = await window.rc.screen(serial);
    if (shot.ok && shot.image) {
      setImage(shot.image);
      setNote('');
      return true;
    }
    setNote('The controller did not return a screen capture.');
    return false;
  };

  // Live view: one capture after another, each waiting for the one before it.
  useEffect(() => {
    if (!live || !serial) {
      return undefined;
    }
    let stopped = false;
    const loop = async (): Promise<void> => {
      let failures = 0;
      while (!stopped) {
        const startedAt = Date.now();
        failures = (await capture()) ? 0 : failures + 1;
        if (failures >= 3) {
          setLive(false);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, SCREEN_INTERVAL_MS - (Date.now() - startedAt))));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
    // capture only reads `serial`, which is already a dependency.
  }, [live, serial]);

  const once = async (): Promise<void> => {
    setBusy(true);
    await capture();
    setBusy(false);
  };

  const save = async (): Promise<void> => {
    const saved = await window.rc.screenSave();
    if (saved.ok) {
      setNote(`Saved to ${saved.file}`);
    } else if (saved.output !== 'cancelled') {
      setNote(saved.output);
    }
  };

  return (
    <Panel px="18px" py="16px">
      <Overline>Screen</Overline>
      <Text fontSize="11.5px" color="fg.muted" mt="6px" mb="12px">
        Shows the controller&apos;s screen here. The live view refreshes a couple of times a second; it is a
        view only and does not send touches.
      </Text>
      <Flex gap="8px" wrap="wrap">
        <Btn variant="primary" disabled={!serial} onClick={() => setLive((on) => !on)}>
          {live ? 'Stop live view' : 'Start live view'}
        </Btn>
        <Btn disabled={!serial || busy || live} onClick={() => void once()}>
          {busy ? 'Capturing…' : 'Capture once'}
        </Btn>
        <Btn disabled={!image} onClick={() => void save()}>
          Save screenshot
        </Btn>
      </Flex>
      {note && <Mono>{note}</Mono>}
      {image && (
        <Box mt="14px" borderRadius="10px" borderWidth="1px" borderColor="border" overflow="hidden" bg="bg.raised">
          <img src={image} alt="Controller screen" style={{ display: 'block', width: '100%', height: 'auto' }} />
        </Box>
      )}
    </Panel>
  );
}

export default RemoteControllerPanel;
