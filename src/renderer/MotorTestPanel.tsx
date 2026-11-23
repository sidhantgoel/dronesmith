import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Flex, Text, chakra } from '@chakra-ui/react';
import type { DroneState, GimbalAngles, GimbalAxis, PropTestEvent } from '../types';
import {
  GIMBAL_AXES,
  GIMBAL_JOG_INTERVAL_MS,
  GIMBAL_JOG_RATE,
  GIMBAL_JOG_SECONDS,
  GIMBAL_SWEEP_SPEEDS,
  GIMBAL_ZERO,
  PROP_DURATIONS,
  PROP_MOTORS,
  PROP_OUTPUTS,
  beepSupport,
  gimbalSweepPlan,
  gimbalTestSupport,
  propTestSupport,
  type GimbalLimits,
  type PropMotor,
} from '../motorTest';
import { AlertIcon, PlayIcon } from './icons';
import { Btn, Chip, Overline, PageHeader, Panel } from './ui';
import type { LogDraft } from './useActivityLog';

type Log = (draft: LogDraft) => void;
type TabKey = 'gimbal' | 'props' | 'beep';

const TABS: { key: TabKey; title: string }[] = [
  { key: 'gimbal', title: 'Gimbal motors' },
  { key: 'props', title: 'Propeller motors' },
  { key: 'beep', title: 'Motor beep' },
];

const AXIS_COLOR: Record<GimbalAxis, string> = { pitch: '#14b8a6', roll: '#3b82f6', yaw: '#f59e0b' };

const POSITION: Record<PropMotor['pos'], string> = {
  FR: 'Front right',
  FL: 'Front left',
  RL: 'Rear left',
  RR: 'Rear right',
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)}°`;

function StopBtn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <chakra.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      h="32px"
      px="13px"
      borderRadius="8px"
      borderWidth="1px"
      borderColor="danger"
      bg="danger"
      color="white"
      fontSize="12.5px"
      fontWeight="600"
      whiteSpace="nowrap"
      cursor="pointer"
      _hover={{ opacity: 0.9 }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'danger', outlineOffset: '2px' }}
      _disabled={{ bg: 'bg.raised', borderColor: 'border', color: 'fg.subtle', cursor: 'not-allowed', opacity: 1 }}
    >
      {children}
    </chakra.button>
  );
}

/** A row of mutually exclusive values, e.g. the sweep speeds. */
function Choices({
  values,
  value,
  unit,
  disabled,
  onChange,
}: {
  values: number[];
  value: number;
  unit: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Flex gap="6px" wrap="wrap">
      {values.map((option) => {
        const active = option === value;
        return (
          <chakra.button
            key={option}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option)}
            h="26px"
            px="11px"
            borderRadius="full"
            borderWidth="1px"
            borderColor={active ? 'accent' : 'border.strong'}
            bg={active ? 'accent' : 'transparent'}
            color={active ? 'fg.onAccent' : 'fg.muted'}
            fontSize="12px"
            fontWeight="600"
            cursor="pointer"
            _hover={{ color: active ? 'fg.onAccent' : 'fg' }}
            _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
            _disabled={{ cursor: 'not-allowed', opacity: 0.6 }}
          >
            {option}
            {unit}
          </chakra.button>
        );
      })}
    </Flex>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <Flex align="flex-start" gap="8px" color="warn" mb="14px">
      <Box mt="2px" flexShrink={0}>
        <AlertIcon size={15} />
      </Box>
      <Box fontSize="12.5px">{children}</Box>
    </Flex>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <chakra.label display="flex" alignItems="flex-start" gap="8px" cursor="pointer" mt="6px">
      <chakra.input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} mt="2px" />
      <Text fontSize="12.5px" color="fg">
        {children}
      </Text>
    </chakra.label>
  );
}

function NumberField({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <chakra.input
      type="number"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      w="full"
      minW="0"
      h="28px"
      px="8px"
      fontFamily="mono"
      fontSize="12px"
      textAlign="center"
      bg="bg.raised"
      borderWidth="1px"
      borderColor="border.strong"
      borderRadius="6px"
      color="fg"
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
      _disabled={{ color: 'fg.subtle', cursor: 'not-allowed' }}
    />
  );
}

/** Where a commanded angle sits inside the axis travel. */
function AngleBar({ value, min, max, color }: { value: number; min: number; max: number; color: string }) {
  const at = (angle: number): string => `${((clamp(angle, min, max) - min) / (max - min || 1)) * 100}%`;
  return (
    <Box mt="12px">
      <Box position="relative" h="6px" borderRadius="full" bg="bg.raised">
        <Box position="absolute" top="-3px" h="12px" w="1px" bg="fg.subtle" left={at(0)} />
        <Box
          position="absolute"
          top="50%"
          w="12px"
          h="12px"
          borderRadius="full"
          transform="translate(-50%, -50%)"
          transition="left 0.25s linear"
          left={at(value)}
          style={{ background: color }}
        />
      </Box>
      <Flex justify="space-between" mt="5px" fontFamily="mono" fontSize="10.5px" color="fg.subtle">
        <Text>{min}°</Text>
        <Text>{max}°</Text>
      </Flex>
    </Box>
  );
}

function ResultLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <Box
      mt="14px"
      p="10px 12px"
      borderRadius="8px"
      bg={ok ? 'bg.raised' : 'danger.soft'}
      borderLeftWidth="2px"
      borderColor={ok ? 'ok' : 'danger'}
    >
      <Text className="selectable" fontSize="12.5px">
        {text}
      </Text>
    </Box>
  );
}

// ── Gimbal motors ────────────────────────────────────────────────────────────

function GimbalTest({ drone, onLog }: { drone: DroneState; onLog?: Log }) {
  const connected = drone.status === 'connected';
  const code = drone.modelCode ?? '';
  const support = useMemo(() => gimbalTestSupport(code), [code]);
  const [allowUntested, setAllowUntested] = useState(false);
  const usable = connected && (support.validated || allowUntested);

  const [commanded, setCommanded] = useState<GimbalAngles>(GIMBAL_ZERO);
  const [ranges, setRanges] = useState<GimbalLimits>(support.limits);
  const [goTo, setGoTo] = useState<Record<GimbalAxis, string>>({ pitch: '0', roll: '0', yaw: '0' });
  const [speed, setSpeed] = useState(GIMBAL_SWEEP_SPEEDS[0]);
  const [sweeping, setSweeping] = useState<GimbalAxis | null>(null);
  const [stepInfo, setStepInfo] = useState('');
  const [acks, setAcks] = useState(0);
  const [error, setError] = useState('');

  const commandedRef = useRef<GimbalAngles>(GIMBAL_ZERO);
  const stopRef = useRef(false);
  const jogTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // A different aircraft has different travel: start again from its limits.
  useEffect(() => {
    setRanges(support.limits);
  }, [support]);

  useEffect(
    () => () => {
      stopRef.current = true;
      if (jogTimer.current) {
        clearInterval(jogTimer.current);
      }
    },
    [],
  );

  const remember = (angles: GimbalAngles): void => {
    commandedRef.current = angles;
    setCommanded(angles);
  };

  const move = async (axis: GimbalAxis | null, target: GimbalAngles, seconds: number): Promise<boolean> => {
    const result = await window.drone.gimbalTestMove(axis, target, seconds, allowUntested);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setError('');
    setAcks(result.acks ?? 0);
    remember(target);
    return true;
  };

  /** Waits in short slices so Stop takes effect straight away. */
  const pause = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (!stopRef.current && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, until - Date.now())));
    }
  };

  const stopJog = (axis: GimbalAxis): void => {
    if (!jogTimer.current) {
      return;
    }
    clearInterval(jogTimer.current);
    jogTimer.current = null;
    void window.drone.gimbalTestJog(axis, 0, 0.1, allowUntested);
  };

  const startJog = (axis: GimbalAxis, direction: number): void => {
    if (!usable || sweeping) {
      return;
    }
    if (jogTimer.current) {
      clearInterval(jogTimer.current);
    }
    const tick = (): void => {
      const next = commandedRef.current[axis] + (direction * GIMBAL_JOG_RATE * GIMBAL_JOG_INTERVAL_MS) / 1000;
      if (next < ranges[axis].min || next > ranges[axis].max) {
        stopJog(axis);
        return;
      }
      void window.drone
        .gimbalTestJog(axis, direction * GIMBAL_JOG_RATE, GIMBAL_JOG_SECONDS, allowUntested)
        .then((result) => {
          if (result.ok) {
            setAcks(result.acks ?? 0);
          } else {
            setError(result.message);
          }
        });
      remember({ ...commandedRef.current, [axis]: next });
    };
    tick();
    jogTimer.current = setInterval(tick, GIMBAL_JOG_INTERVAL_MS);
  };

  const stopAll = async (): Promise<void> => {
    stopRef.current = true;
    if (jogTimer.current) {
      clearInterval(jogTimer.current);
      jogTimer.current = null;
    }
    const result = await window.drone.gimbalTestStop();
    if (!result.ok) {
      setError(result.message);
    }
    onLog?.({ level: result.ok ? 'warn' : 'error', text: 'Gimbal motor test: stop', detail: result.message });
  };

  const center = async (): Promise<void> => {
    if (!usable || sweeping) {
      return;
    }
    if (await move(null, GIMBAL_ZERO, 2)) {
      setGoTo({ pitch: '0', roll: '0', yaw: '0' });
      onLog?.({ level: 'info', text: 'Gimbal motor test: centre', detail: 'Pitch, roll and yaw to 0°.' });
    }
  };

  const goToAngle = async (axis: GimbalAxis): Promise<void> => {
    if (!usable || sweeping) {
      return;
    }
    const target = clamp(Number(goTo[axis]) || 0, ranges[axis].min, ranges[axis].max);
    const current = commandedRef.current;
    const seconds = Math.max(1, Math.abs(target - current[axis]) / speed);
    if (await move(axis, { ...current, [axis]: target }, seconds)) {
      onLog?.({ level: 'info', text: `Gimbal motor test: ${axis} to ${target.toFixed(1)}°` });
    }
  };

  const sweep = async (axis: GimbalAxis): Promise<void> => {
    if (!usable || sweeping) {
      return;
    }
    const { min, max } = ranges[axis];
    const plan = gimbalSweepPlan(commandedRef.current[axis], min, max, speed);
    stopRef.current = false;
    setSweeping(axis);
    onLog?.({
      level: 'info',
      text: `Gimbal motor test: sweep ${axis}`,
      detail: `${min}° to ${max}° at ${speed}°/s.`,
    });
    let completed = false;
    try {
      // Take hold of the axis at its current angle before the first stride.
      if (await move(axis, { ...commandedRef.current }, 0.5)) {
        completed = true;
        for (let index = 0; index < plan.points.length; index++) {
          if (stopRef.current) {
            completed = false;
            break;
          }
          setStepInfo(`Step ${index + 1} of ${plan.points.length} · target ${plan.points[index].toFixed(1)}°`);
          if (!(await move(axis, { ...commandedRef.current, [axis]: plan.points[index] }, plan.stepSeconds))) {
            completed = false;
            break;
          }
          await pause(plan.stepSeconds * 1000 + 150);
        }
      }
    } finally {
      setSweeping(null);
      setStepInfo('');
    }
    onLog?.({
      level: completed ? 'ok' : 'warn',
      text: `Gimbal motor test: ${axis} sweep ${completed ? 'done' : 'stopped'}`,
    });
  };

  const setRange = (axis: GimbalAxis, edge: 'min' | 'max', raw: string): void => {
    const bound = support.limits[axis];
    const value = clamp(Number(raw) || 0, bound.min, bound.max);
    setRanges((current) => ({ ...current, [axis]: { ...current[axis], [edge]: value } }));
  };

  const busy = sweeping !== null;

  return (
    <Box>
      {connected && !support.validated && (
        <Panel px="18px" py="14px" mb="14px">
          <Notice>
            This test is validated on DJI Mini 3 Pro, Mini 4 Pro, Mini 5 Pro and Lito 1.{' '}
            {drone.model ?? 'This aircraft'} has not been tested with it.
          </Notice>
          <Check checked={allowUntested} onChange={setAllowUntested}>
            Run it anyway, with travel reduced to pitch −40° to +30° and roll and yaw ±20°.
          </Check>
        </Panel>
      )}

      <Panel px="18px" py="14px" mb="14px">
        <Overline>Before you start</Overline>
        <Text mt="8px" color="fg.muted">
          Remove the gimbal cover and place the drone level on the bench, motors off. The readouts show the
          angle that was commanded, not a measured one, so watch the gimbal itself.
        </Text>
      </Panel>

      <Flex align="center" gap="10px" mb="14px" wrap="wrap">
        <Chip tone={acks > 0 ? 'ok' : 'neutral'}>{acks > 0 ? `Gimbal answering · ${acks}` : 'No answer yet'}</Chip>
        {stepInfo && (
          <Text fontFamily="mono" fontSize="12px" color="fg.muted">
            {stepInfo}
          </Text>
        )}
        <Flex gap="8px" ml="auto">
          <Btn disabled={!usable || busy} onClick={() => void center()}>
            Centre
          </Btn>
          <StopBtn disabled={!connected} onClick={() => void stopAll()}>
            Stop gimbal
          </StopBtn>
        </Flex>
      </Flex>

      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="14px">
        {GIMBAL_AXES.map((axis) => {
          const range = ranges[axis.id];
          const own = sweeping === axis.id;
          return (
            <Panel key={axis.id} p="16px" borderColor={own ? 'accent' : 'border'}>
              <Flex align="baseline" justify="space-between" gap="10px">
                <Box>
                  <chakra.h2 fontFamily="heading" fontSize="15px" fontWeight="600">
                    {axis.label}
                  </chakra.h2>
                  <Text fontSize="11.5px" color="fg.subtle">
                    Motor {axis.motor}
                  </Text>
                </Box>
                <Text fontFamily="mono" fontSize="20px" lineHeight="1" style={{ color: AXIS_COLOR[axis.id] }}>
                  {signed(commanded[axis.id])}
                </Text>
              </Flex>

              <AngleBar value={commanded[axis.id]} min={range.min} max={range.max} color={AXIS_COLOR[axis.id]} />

              <Box display="grid" gridTemplateColumns="1fr 1fr" gap="8px" mt="12px">
                {(['min', 'max'] as const).map((edge) => (
                  <Box key={edge}>
                    <Overline>{edge} °</Overline>
                    <Box mt="4px">
                      <NumberField
                        label={`${axis.label} sweep ${edge}`}
                        value={String(range[edge])}
                        disabled={!usable || busy}
                        onChange={(raw) => setRange(axis.id, edge, raw)}
                      />
                    </Box>
                  </Box>
                ))}
              </Box>

              <Flex mt="10px">
                <Box flex="1" display="grid">
                  {own ? (
                    <Btn onClick={() => void stopAll()}>Stop {axis.label.toLowerCase()} sweep</Btn>
                  ) : (
                    <Btn
                      variant="primary"
                      disabled={!usable || busy}
                      onClick={() => void sweep(axis.id)}
                      icon={<PlayIcon size={14} />}
                    >
                      Sweep {axis.label.toLowerCase()}
                    </Btn>
                  )}
                </Box>
              </Flex>

              <Box display="grid" gridTemplateColumns="1fr 1fr" gap="8px" mt="8px">
                {[-1, 1].map((direction) => (
                  <chakra.button
                    key={direction}
                    type="button"
                    disabled={!usable || busy}
                    onPointerDown={() => startJog(axis.id, direction)}
                    onPointerUp={() => stopJog(axis.id)}
                    onPointerLeave={() => stopJog(axis.id)}
                    h="30px"
                    borderRadius="8px"
                    borderWidth="1px"
                    borderColor="border.strong"
                    fontSize="12px"
                    fontWeight="600"
                    cursor="pointer"
                    _hover={{ bg: 'bg.raised' }}
                    _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
                    _disabled={{ color: 'fg.subtle', cursor: 'not-allowed' }}
                  >
                    {direction < 0 ? '◀ Jog −' : 'Jog + ▶'}
                  </chakra.button>
                ))}
              </Box>

              <Flex gap="8px" mt="8px" align="center">
                <NumberField
                  label={`${axis.label} target angle`}
                  value={goTo[axis.id]}
                  disabled={!usable || busy}
                  onChange={(raw) => setGoTo((current) => ({ ...current, [axis.id]: raw }))}
                />
                <Btn disabled={!usable || busy} onClick={() => void goToAngle(axis.id)}>
                  Go
                </Btn>
              </Flex>
            </Panel>
          );
        })}
      </Box>

      <Panel px="18px" py="14px" mt="14px">
        <Flex align="center" justify="space-between" gap="12px" wrap="wrap">
          <Box>
            <Overline>Sweep speed</Overline>
            <Text mt="4px" fontFamily="mono" fontSize="18px">
              {speed}
              <Text as="span" fontSize="12px" color="fg.subtle">
                {' '}
                °/s
              </Text>
            </Text>
          </Box>
          <Choices values={GIMBAL_SWEEP_SPEEDS} value={speed} unit="" disabled={busy} onChange={setSpeed} />
        </Flex>
        <Text mt="10px" fontSize="12px" color="fg.muted">
          Listen and watch for grinding, stalls, jumps or a motor that cannot hold its angle. Hold a Jog button
          to move slowly; release it to hold.
        </Text>
      </Panel>

      {error && <ResultLine ok={false} text={error} />}
    </Box>
  );
}

// ── Propeller motors ─────────────────────────────────────────────────────────

interface MotorOutcome {
  ok: boolean;
  note: string;
  runs: number;
}

function MotorCard({
  motor,
  spinning,
  remaining,
  outcome,
  disabled,
  onTest,
}: {
  motor: PropMotor;
  spinning: boolean;
  remaining: number;
  outcome?: MotorOutcome;
  disabled: boolean;
  onTest: () => void;
}) {
  let status = 'Not tested';
  let statusColor = 'fg.subtle';
  if (spinning) {
    status = `Spinning · ${remaining.toFixed(1)} s`;
    statusColor = 'accent';
  } else if (outcome) {
    status = outcome.ok ? `Ran · ${outcome.note}` : outcome.note;
    statusColor = outcome.ok ? 'ok' : 'danger';
  }
  return (
    <chakra.button
      type="button"
      disabled={disabled}
      onClick={onTest}
      aria-label={`Test motor ${motor.n}, ${POSITION[motor.pos]}`}
      display="flex"
      flexDirection="column"
      alignItems="flex-start"
      gap="3px"
      p="12px 14px"
      minH="92px"
      textAlign="left"
      borderRadius="12px"
      borderWidth="1px"
      borderColor={spinning ? 'accent' : 'border.strong'}
      bg={spinning ? 'accent.soft' : 'bg.panel'}
      cursor="pointer"
      transition="background 0.12s, border-color 0.12s"
      _hover={{ bg: spinning ? 'accent.soft' : 'bg.raised' }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '2px' }}
      _disabled={{ cursor: 'not-allowed' }}
    >
      <Flex align="center" gap="8px" w="full">
        <Text fontFamily="heading" fontSize="16px" fontWeight="600">
          M{motor.n}
        </Text>
        <Text fontFamily="mono" fontSize="11px" color="fg.subtle" ml="auto">
          {motor.dir}
        </Text>
      </Flex>
      <Text fontSize="12px" color="fg.muted">
        {POSITION[motor.pos]}
      </Text>
      <Text fontSize="11.5px" color={statusColor} mt="auto">
        {status}
      </Text>
    </chakra.button>
  );
}

function PropTest({ drone, onLog }: { drone: DroneState; onLog?: Log }) {
  const connected = drone.status === 'connected';
  const support = useMemo(() => propTestSupport(drone.modelCode), [drone.modelCode]);
  const [allowUntested, setAllowUntested] = useState(false);
  const [propsOff, setPropsOff] = useState(false);
  const [percent, setPercent] = useState(10);
  const [seconds, setSeconds] = useState(3);
  const [busy, setBusy] = useState(false);
  const [spinning, setSpinning] = useState<{ motor: number; endsAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [outcomes, setOutcomes] = useState<Record<number, MotorOutcome>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const busyRef = useRef(false);

  const usable = connected && propsOff && (support.validated || allowUntested);

  useEffect(
    () =>
      window.drone.onPropTest((event: PropTestEvent) => {
        if (event.phase === 'spinning') {
          setSpinning({ motor: event.motor, endsAt: event.endsAt ?? Date.now() });
          return;
        }
        setSpinning(null);
        const ok = event.phase === 'done';
        const note = event.phase === 'stopped' ? 'Stopped' : (event.note ?? '');
        setOutcomes((current) => ({
          ...current,
          [event.motor]: { ok, note: ok ? note : note.charAt(0).toUpperCase() + note.slice(1), runs: (current[event.motor]?.runs ?? 0) + 1 },
        }));
      }),
    [],
  );

  useEffect(() => {
    if (!spinning) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [spinning]);

  // Leaving the page must not leave a motor running.
  useEffect(
    () => () => {
      if (busyRef.current) {
        void window.drone.propTestStop();
      }
    },
    [],
  );

  const run = async (motors: number[]): Promise<void> => {
    if (!usable || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setResult(null);
    const label = motors.length === 1 ? `M${motors[0]}` : 'all motors, one by one';
    onLog?.({ level: 'info', text: `Propeller motor test: ${label}`, detail: `${percent} % for ${seconds} s.` });
    try {
      const outcome = await window.drone.propTestRun(motors, percent, seconds, {
        propsRemoved: propsOff,
        allowUntested,
      });
      setResult({ ok: outcome.ok, text: outcome.message });
      onLog?.({
        level: outcome.ok ? 'ok' : 'error',
        text: `Propeller motor test: ${outcome.ok ? 'done' : 'not completed'}`,
        detail: outcome.message,
      });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      busyRef.current = false;
      setBusy(false);
      setSpinning(null);
    }
  };

  const stop = async (): Promise<void> => {
    const outcome = await window.drone.propTestStop();
    if (!busyRef.current) {
      setResult({ ok: outcome.ok, text: outcome.message });
    }
    onLog?.({ level: outcome.ok ? 'warn' : 'error', text: 'Propeller motor test: stop', detail: outcome.message });
  };

  const remaining = spinning ? Math.max(0, (spinning.endsAt - now) / 1000) : 0;
  const card = (pos: PropMotor['pos']): ReactNode => {
    const motor = PROP_MOTORS.find((entry) => entry.pos === pos) as PropMotor;
    return (
      <MotorCard
        motor={motor}
        spinning={spinning?.motor === motor.n}
        remaining={remaining}
        outcome={outcomes[motor.n]}
        disabled={!usable || busy}
        onTest={() => void run([motor.n])}
      />
    );
  };

  return (
    <Box>
      {connected && !support.validated && (
        <Panel px="18px" py="14px" mb="14px">
          <Notice>
            This test is validated on DJI Mini 3 Pro, Mini 4 Pro, Mini 5 Pro and Lito 1.{' '}
            {drone.model ?? 'This aircraft'} has not been tested with it.
          </Notice>
          <Check checked={allowUntested} onChange={setAllowUntested}>
            Try it anyway. A motor is only run after the flight controller confirms that the command is its
            motor test; otherwise nothing spins.
          </Check>
        </Panel>
      )}

      <Panel px="18px" py="14px" mb="14px" borderColor={propsOff ? 'ok' : 'danger'}>
        <Check checked={propsOff} onChange={setPropsOff}>
          <Text as="span" fontWeight="600">
            All propellers are removed.
          </Text>{' '}
          The motors spin for real: keep fingers, cables and tools clear.
        </Check>
      </Panel>

      <Box display="grid" gridTemplateColumns={{ base: '1fr', lg: '3fr 2fr' }} gap="14px">
        <Panel p="16px">
          <Flex align="center" justify="space-between" gap="10px" mb="12px">
            <Overline>Top view · nose up</Overline>
            <StopBtn disabled={!connected} onClick={() => void stop()}>
              Stop motors
            </StopBtn>
          </Flex>
          <Box display="grid" gridTemplateColumns="1fr 64px 1fr" gap="12px" alignItems="stretch">
            {card('FL')}
            <Flex
              gridRow="span 2"
              direction="column"
              align="center"
              justify="center"
              gap="6px"
              borderRadius="16px"
              borderWidth="1px"
              borderColor="border.strong"
              bg="bg.raised"
              color="fg.subtle"
              fontSize="11px"
              aria-hidden="true"
            >
              <Text fontSize="14px" lineHeight="1">
                ▲
              </Text>
              <Text>Nose</Text>
            </Flex>
            {card('FR')}
            {card('RL')}
            {card('RR')}
          </Box>
          <Flex mt="14px">
            <Box flex="1" display="grid">
              <Btn
                variant="primary"
                disabled={!usable || busy}
                onClick={() => void run(PROP_MOTORS.map((motor) => motor.n))}
                icon={<PlayIcon size={14} />}
              >
                {busy ? 'Running…' : 'Test all, one by one'}
              </Btn>
            </Box>
          </Flex>
        </Panel>

        <Flex direction="column" gap="14px">
          <Panel p="16px">
            <Overline>Output</Overline>
            <Text mt="4px" mb="10px" fontFamily="mono" fontSize="20px">
              {percent}
              <Text as="span" fontSize="12px" color="fg.subtle">
                {' '}
                %
              </Text>
            </Text>
            <Choices values={PROP_OUTPUTS} value={percent} unit=" %" disabled={busy} onChange={setPercent} />
          </Panel>
          <Panel p="16px">
            <Overline>Duration</Overline>
            <Text mt="4px" mb="10px" fontFamily="mono" fontSize="20px">
              {seconds}
              <Text as="span" fontSize="12px" color="fg.subtle">
                {' '}
                s
              </Text>
            </Text>
            <Choices values={PROP_DURATIONS} value={seconds} unit=" s" disabled={busy} onChange={setSeconds} />
          </Panel>
        </Flex>
      </Box>

      <Text mt="12px" fontSize="12px" color="fg.muted">
        The flight controller spins one motor at a time. The speed controllers do not report RPM here, so
        watch and listen to each motor: it should start smoothly, sound even and stop cleanly. A motor that
        spins in the wrong position points to swapped wiring.
      </Text>

      {result && <ResultLine ok={result.ok} text={result.text} />}
    </Box>
  );
}

// ── Motor beep ───────────────────────────────────────────────────────────────

function BeepTest({ drone, onLog }: { drone: DroneState; onLog?: Log }) {
  const connected = drone.status === 'connected';
  const support = useMemo(() => beepSupport(drone.modelCode), [drone.modelCode]);
  const [allowUntested, setAllowUntested] = useState(false);
  const [beeping, setBeeping] = useState<number[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const beepingRef = useRef<number[]>([]);
  beepingRef.current = beeping;

  const usable = connected && (support.validated || allowUntested);

  // Leaving the page, or losing the aircraft, must not leave a motor beeping.
  useEffect(
    () => () => {
      if (beepingRef.current.length > 0) {
        void window.drone.motorBeepStop();
      }
    },
    [],
  );
  useEffect(() => {
    if (!connected) {
      setBeeping([]);
    }
  }, [connected]);

  const toggle = async (motor: PropMotor): Promise<void> => {
    const on = !beeping.includes(motor.n);
    const outcome = await window.drone.motorBeep(motor.n, on, allowUntested);
    setResult({ ok: outcome.ok, text: outcome.message });
    if (outcome.ok) {
      setBeeping((current) => (on ? [...current, motor.n] : current.filter((n) => n !== motor.n)));
      onLog?.({ level: 'info', text: `Motor beep: ${outcome.message}` });
    }
  };

  const stopAll = async (): Promise<void> => {
    const outcome = await window.drone.motorBeepStop();
    setResult({ ok: outcome.ok, text: outcome.message });
    setBeeping([]);
  };

  return (
    <Box>
      {connected && !support.validated && (
        <Panel px="18px" py="14px" mb="14px">
          <Notice>The motor beep was not validated on this aircraft. It may stay silent.</Notice>
          <Check checked={allowUntested} onChange={setAllowUntested}>
            Try it on this aircraft anyway
          </Check>
        </Panel>
      )}

      <Panel px="18px" py="14px" mb="14px">
        <Text fontSize="12.5px" color="fg.muted">
          Each motor sounds a tone without spinning, so you can tell which arm is which and whether a
          motor and its speed controller respond at all.
          {support.factoryMode ? ' This aircraft is put into factory mode while a motor beeps.' : ''}
        </Text>
      </Panel>

      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="12px">
        {PROP_MOTORS.map((motor) => {
          const on = beeping.includes(motor.n);
          return (
            <Panel key={motor.n} p="16px" borderColor={on ? 'accent' : 'border'}>
              <Flex align="center" justify="space-between" gap="8px">
                <Text fontFamily="heading" fontSize="15px" fontWeight="600">
                  M{motor.n}
                </Text>
                {on && (
                  <Chip tone="accent" pulse>
                    Beeping
                  </Chip>
                )}
              </Flex>
              <Text fontSize="12.5px" color="fg.muted" mt="2px" mb="12px">
                {POSITION[motor.pos]}
              </Text>
              <Btn variant={on ? 'quiet' : 'primary'} disabled={!usable} onClick={() => void toggle(motor)}>
                {on ? 'Stop beep' : 'Beep'}
              </Btn>
            </Panel>
          );
        })}
      </Box>

      <Flex justify="flex-end" mt="14px">
        <StopBtn disabled={!connected || beeping.length === 0} onClick={() => void stopAll()}>
          Silence all
        </StopBtn>
      </Flex>

      {result && <ResultLine ok={result.ok} text={result.text} />}
    </Box>
  );
}

function MotorTestPanel({ drone, onLog }: { drone: DroneState; onLog?: Log }) {
  const [tab, setTab] = useState<TabKey>('gimbal');
  const connected = drone.status === 'connected';

  return (
    <Box>
      <PageHeader
        title="Motor test"
        subtitle="Move each gimbal motor, or spin or beep each propeller motor, on its own to find a weak, noisy or dead one."
      />

      {!connected && (
        <Flex align="center" gap="8px" mb="14px" color="warn">
          <AlertIcon size={15} />
          <Text>Link an aircraft to run the motor tests.</Text>
        </Flex>
      )}

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
        {TABS.map((entry) => (
          <chakra.button
            key={entry.key}
            type="button"
            aria-pressed={entry.key === tab}
            onClick={() => setTab(entry.key)}
            flex="1 1 auto"
            px="12px"
            h="30px"
            fontSize="12.5px"
            fontWeight={entry.key === tab ? '600' : '500'}
            borderRadius="7px"
            bg={entry.key === tab ? 'bg.surface' : 'transparent'}
            color={entry.key === tab ? 'fg' : 'fg.muted'}
            borderWidth="1px"
            borderColor={entry.key === tab ? 'border.strong' : 'transparent'}
            cursor="pointer"
            _hover={{ color: 'fg' }}
            _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '1px' }}
          >
            {entry.title}
          </chakra.button>
        ))}
      </Flex>

      {tab === 'gimbal' && <GimbalTest drone={drone} onLog={onLog} />}
      {tab === 'props' && <PropTest drone={drone} onLog={onLog} />}
      {tab === 'beep' && <BeepTest drone={drone} onLog={onLog} />}
    </Box>
  );
}

export default MotorTestPanel;
