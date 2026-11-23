import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Flex, Text, chakra, type BoxProps } from '@chakra-ui/react';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'fg.muted',
  accent: 'accent',
  ok: 'ok',
  warn: 'warn',
  danger: 'danger',
};

const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg.raised',
  accent: 'accent.soft',
  ok: 'ok.soft',
  warn: 'warn.soft',
  danger: 'danger.soft',
};

const FOCUS_RING = {
  outline: '2px solid',
  outlineColor: 'accent',
  outlineOffset: '2px',
};

/** Small uppercase label above a value or a group. */
export function Overline({ children }: { children: ReactNode }) {
  return (
    <Text
      fontSize="10.5px"
      fontWeight="600"
      letterSpacing="0.09em"
      textTransform="uppercase"
      color="fg.subtle"
    >
      {children}
    </Text>
  );
}

export function Panel(props: BoxProps) {
  return (
    <Box
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border"
      borderRadius="12px"
      {...props}
    />
  );
}

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <Box
      className={pulse ? 'pulse' : undefined}
      w="8px"
      h="8px"
      borderRadius="full"
      flexShrink={0}
      color={TONE_COLOR[tone]}
      bg="currentColor"
    />
  );
}

export function Chip({
  tone,
  pulse = false,
  children,
}: {
  tone: Tone;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <Flex
      align="center"
      gap="6px"
      h="22px"
      px="9px"
      borderRadius="full"
      bg={TONE_SOFT[tone]}
      color={TONE_COLOR[tone]}
      fontSize="11.5px"
      fontWeight="600"
      whiteSpace="nowrap"
      flexShrink={0}
    >
      <Box
        className={pulse ? 'pulse' : undefined}
        w="6px"
        h="6px"
        borderRadius="full"
        bg="currentColor"
      />
      {children}
    </Flex>
  );
}

interface BtnProps {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'quiet';
  icon?: ReactNode;
}

export function Btn({ children, onClick, disabled, variant = 'quiet', icon }: BtnProps) {
  const primary = variant === 'primary';
  return (
    <chakra.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      gap="7px"
      h="32px"
      px="13px"
      borderRadius="8px"
      borderWidth="1px"
      fontSize="12.5px"
      fontWeight="600"
      whiteSpace="nowrap"
      cursor="pointer"
      transition="background 0.12s, border-color 0.12s, color 0.12s"
      bg={primary ? 'accent' : 'transparent'}
      color={primary ? 'fg.onAccent' : 'fg'}
      borderColor={primary ? 'accent' : 'border.strong'}
      _hover={
        primary
          ? { bg: 'accent.hover', borderColor: 'accent.hover' }
          : { bg: 'bg.raised' }
      }
      _focusVisible={FOCUS_RING}
      _disabled={{
        bg: primary ? 'bg.raised' : 'transparent',
        borderColor: 'border',
        color: 'fg.subtle',
        cursor: 'not-allowed',
      }}
    >
      {icon}
      {children}
    </chakra.button>
  );
}

interface IconBtnProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
}

export function IconBtn({
  label,
  onClick,
  children,
  disabled,
  pressed,
  className,
}: IconBtnProps) {
  return (
    <chakra.button
      type="button"
      className={className}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      disabled={disabled}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      w="28px"
      h="28px"
      borderRadius="7px"
      cursor="pointer"
      color={pressed ? 'fg' : 'fg.muted'}
      bg={pressed ? 'bg.raised' : 'transparent'}
      transition="background 0.12s, color 0.12s"
      _hover={{ bg: 'bg.raised', color: 'fg' }}
      _focusVisible={FOCUS_RING}
      _disabled={{ color: 'fg.subtle', bg: 'transparent', cursor: 'not-allowed' }}
    >
      {children}
    </chakra.button>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <Flex align="flex-end" justify="space-between" gap="16px" wrap="wrap" mb="18px">
      <Box minW="0">
        <chakra.h1
          fontFamily="heading"
          fontSize="21px"
          fontWeight="600"
          letterSpacing="-0.01em"
          lineHeight="1.2"
        >
          {title}
        </chakra.h1>
        <Text color="fg.muted" mt="4px">
          {subtitle}
        </Text>
      </Box>
      {actions}
    </Flex>
  );
}

/** Copies text to the clipboard and reports the outcome for a short while. */
export function useCopy(): {
  state: 'idle' | 'copied' | 'failed';
  copy: (text: string) => void;
} {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const copy = useCallback((text: string) => {
    const settle = (next: 'copied' | 'failed'): void => {
      setState(next);
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => setState('idle'), 1600);
    };
    navigator.clipboard.writeText(text).then(
      () => settle('copied'),
      () => settle('failed'),
    );
  }, []);

  return { state, copy };
}
