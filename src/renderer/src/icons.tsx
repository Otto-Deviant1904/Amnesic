// Minimal 16px stroke icons drawn inline — no icon-font or third-party set,
// so the shell ships zero extra assets and nothing is fetched at runtime.
import type { ReactNode } from 'react'

interface IconProps {
  size?: number
}

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function BackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.5 3.5 6 8l4.5 4.5" />
    </Svg>
  )
}

export function ForwardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 3.5 10 8l-4.5 4.5" />
    </Svg>
  )
}

export function ReloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
      <path d="M13.5 1.75v3h-3" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.75" y="7" width="8.5" height="6" rx="1.5" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
    </Svg>
  )
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 10 8 5.5l4.5 4.5" />
    </Svg>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 6 8 10.5 12.5 6" />
    </Svg>
  )
}

export function SpeakerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6.25h2l3-2.5v8.5l-3-2.5H3z" />
      <path d="M10.5 5.75a3.2 3.2 0 0 1 0 4.5M12.25 4a5.7 5.7 0 0 1 0 8" />
    </Svg>
  )
}

export function SpeakerMutedIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6.25h2l3-2.5v8.5l-3-2.5H3z" />
      <path d="M10.5 6.25 13.75 9.5M13.75 6.25 10.5 9.5" />
    </Svg>
  )
}

export function WarningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.25 14.5 13.5h-13z" />
      <path d="M8 6.5v3.25M8 11.75v.01" />
    </Svg>
  )
}
