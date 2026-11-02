'use client';

import {
  createContext,
  useContext,
  useId,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  Add01Icon,
  Archive01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  Attachment01Icon,
  Award01Icon,
  BookOpen01Icon,
  Bookmark01Icon,
  Calendar03Icon,
  CalendarAdd01Icon,
  Cancel01Icon,
  ChartIncreaseIcon,
  Copy01Icon,
  CreditCardIcon,
  Delete02Icon,
  DeliveryTruck01Icon,
  Download01Icon,
  Edit02Icon,
  File01Icon,
  FileAddIcon,
  Folder01Icon,
  FolderOpenIcon,
  GiftIcon,
  Globe02Icon,
  Home01Icon,
  InboxDownloadIcon,
  InboxIcon,
  InformationCircleIcon,
  Loading03Icon,
  Location01Icon,
  Mailbox01Icon,
  Notification01Icon,
  Package01Icon,
  PauseIcon,
  PlayIcon,
  PrinterIcon,
  Redo02Icon,
  Remove01Icon,
  SaveIcon,
  Search01Icon,
  Settings01Icon,
  ShieldCheckIcon,
  ShoppingBag01Icon,
  SidebarLeft01Icon,
  SlidersHorizontalIcon,
  Sorting01Icon,
  Stamp01Icon,
  Tag01Icon,
  TextBoldIcon,
  TextItalicIcon,
  TextUnderlineIcon,
  Tick02Icon,
  TickDouble02Icon,
  Timer01Icon,
  Undo02Icon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons';
import { THEME_ICON_ARTWORK } from "../../lib/icon-artwork";
import { CENTRAL_OUTLINE_ARTWORK } from "../../lib/icon-artwork";
import { LUCIDE_FILLED_ARTWORK } from "../../lib/icon-artwork";
import {
  CENTRAL_CONTROL_OUTLINES,
  CENTRAL_CONTROL_FILLS,
  CENTRAL_CONTROL_STROKES,
  PHOSPHOR_CONTROL_ARTWORK,
  LUCIDE_CONTROL_FILLS,
} from "../../lib/icon-artwork";
import type { ThemeDefinition } from "../../lib/theme-model";
import {
  isHugeiconsVariant,
  type HugeiconsVariant,
} from "../../lib/hugeicons-options";
import { iconWeightVariables } from "../../lib/theme-icon-weight";

/** Bundled fallback artwork: Hugeicons free, stroke-rounded (MIT). */
function strokeGlyph(icon: IconSvgElement) {
  const outline = icon.map(([tag, attributes]) => {
    const { strokeWidth: _strokeWidth, ...rest } = attributes;
    return [tag, rest] as const;
  });
  return function Glyph({ strokeWidth, style, ...props }: SVGProps<SVGSVGElement>) {
    return (
      <HugeiconsIcon
        icon={outline}
        size={24}
        {...(props as object)}
        style={{ strokeWidth: strokeWidth ?? 'var(--icon-stroke-width, 1.5)', ...style }}
      />
    );
  };
}
const Archive = strokeGlyph(Archive01Icon);
const ArrowDownToLine = strokeGlyph(InboxDownloadIcon);
const ArrowRight = strokeGlyph(ArrowRight02Icon);
const ArrowUp = strokeGlyph(ArrowUp02Icon);
const Award = strokeGlyph(Award01Icon);
const Bell = strokeGlyph(Notification01Icon);
const Bold = strokeGlyph(TextBoldIcon);
const BookOpen = strokeGlyph(BookOpen01Icon);
const Bookmark = strokeGlyph(Bookmark01Icon);
const CalendarDays = strokeGlyph(Calendar03Icon);
const CalendarPlus = strokeGlyph(CalendarAdd01Icon);
const Check = strokeGlyph(Tick02Icon);
const CheckCheck = strokeGlyph(TickDouble02Icon);
const ChevronDown = strokeGlyph(ArrowDown01Icon);
const ChevronLeft = strokeGlyph(ArrowLeft01Icon);
const ChevronRight = strokeGlyph(ArrowRight01Icon);
const Copy = strokeGlyph(Copy01Icon);
const CreditCard = strokeGlyph(CreditCardIcon);
const Download = strokeGlyph(Download01Icon);
const FilePlus = strokeGlyph(FileAddIcon);
const FileText = strokeGlyph(File01Icon);
const Folder = strokeGlyph(Folder01Icon);
const FolderOpen = strokeGlyph(FolderOpenIcon);
const Gift = strokeGlyph(GiftIcon);
const Globe = strokeGlyph(Globe02Icon);
const House = strokeGlyph(Home01Icon);
const Inbox = strokeGlyph(InboxIcon);
const Info = strokeGlyph(InformationCircleIcon);
const Italic = strokeGlyph(TextItalicIcon);
const ListOrdered = strokeGlyph(Sorting01Icon);
const LoaderCircle = strokeGlyph(Loading03Icon);
const Mailbox = strokeGlyph(Mailbox01Icon);
const MapPin = strokeGlyph(Location01Icon);
const Minus = strokeGlyph(Remove01Icon);
const Package = strokeGlyph(Package01Icon);
const PanelLeft = strokeGlyph(SidebarLeft01Icon);
const Paperclip = strokeGlyph(Attachment01Icon);
const Pause = strokeGlyph(PauseIcon);
const Pencil = strokeGlyph(Edit02Icon);
const Play = strokeGlyph(PlayIcon);
const Plus = strokeGlyph(Add01Icon);
const Printer = strokeGlyph(PrinterIcon);
const Redo2 = strokeGlyph(Redo02Icon);
const Save = strokeGlyph(SaveIcon);
const Search = strokeGlyph(Search01Icon);
const Settings = strokeGlyph(Settings01Icon);
const ShieldCheck = strokeGlyph(ShieldCheckIcon);
const ShoppingBag = strokeGlyph(ShoppingBag01Icon);
const SlidersHorizontal = strokeGlyph(SlidersHorizontalIcon);
const Stamp = strokeGlyph(Stamp01Icon);
const Tag = strokeGlyph(Tag01Icon);
const Timer = strokeGlyph(Timer01Icon);
const Trash2 = strokeGlyph(Delete02Icon);
const TrendingUp = strokeGlyph(ChartIncreaseIcon);
const Truck = strokeGlyph(DeliveryTruck01Icon);
const Underline = strokeGlyph(TextUnderlineIcon);
const Undo2 = strokeGlyph(Undo02Icon);
const UsersRound = strokeGlyph(UserGroupIcon);
const X = strokeGlyph(Cancel01Icon);

const lucide = {
  home: House,
  folder: Folder,
  team: UsersRound,
  settings: Settings,
  inboxTray: Inbox,
  shoppingBag: ShoppingBag,
  gift: Gift,
  creditCard: CreditCard,
  award: Award,
  pause: Pause,
  play: Play,
  bookmark: Bookmark,
  arrowRight: ArrowRight,
  archive: Archive,
  inbox: ArrowDownToLine,
  adjust: SlidersHorizontal,
  document: FileText,
  search: Search,
  paperclip: Paperclip,
  bell: Bell,
  trash: Trash2,
  stamp: Stamp,
  globe: Globe,
  pencil: Pencil,
  mailbox: Mailbox,
};
const controls = {
  panelLeft: PanelLeft,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  minus: Minus,
  plus: Plus,
  close: X,
  info: Info,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  copy: Copy,
  download: Download,
  filePlus: FilePlus,
  folderOpen: FolderOpen,
  printer: Printer,
  save: Save,
  undo: Undo2,
  redo: Redo2,
  arrowUp: ArrowUp,
  calendarPlus: CalendarPlus,
  calendarDays: CalendarDays,
  mapPin: MapPin,
  tag: Tag,
  package: Package,
  truck: Truck,
  listOrdered: ListOrdered,
  loader: LoaderCircle,
  timer: Timer,
  bookOpen: BookOpen,
  checkCheck: CheckCheck,
  shieldCheck: ShieldCheck,
  trendingUp: TrendingUp,
};
const allIcons = { ...lucide, ...controls };
const centralOutlines = {
  ...CENTRAL_OUTLINE_ARTWORK,
  ...CENTRAL_CONTROL_OUTLINES,
};
const centralFills = {
  ...THEME_ICON_ARTWORK.Central,
  ...CENTRAL_CONTROL_FILLS,
};
const phosphorArtwork = {
  ...THEME_ICON_ARTWORK.Phosphor,
  ...PHOSPHOR_CONTROL_ARTWORK,
};
const lucideFills: Record<string, { body: string; cutouts?: string }> = {
  ...LUCIDE_FILLED_ARTWORK,
  ...LUCIDE_CONTROL_FILLS,
};
export type ThemeIconName = keyof typeof allIcons;
export const THEME_ICON_NAMES = Object.keys(lucide) as ThemeIconName[];
export const CONTROL_ICON_NAMES = Object.keys(
  controls,
) as (keyof typeof controls)[];

type IconSettings = {
  family?: ThemeDefinition['iconFamily'];
  variant?: 'filled' | 'outlined';
  hugeiconsVariant?: HugeiconsVariant;
};
const IconThemeContext = createContext<IconSettings>({});

/** Reusable theme scope. React context carries the selected artwork through portals. */
export function IconTheme({
  variables,
  children,
}: {
  variables: CSSProperties;
  children: ReactNode;
}) {
  const inherited = useContext(IconThemeContext);
  const tokens = variables as Record<string, string | number | undefined>;
  const family = tokens['--theme-icon-family'];
  const variant = tokens['--theme-icon-style'];
  const hugeiconsVariant = tokens['--theme-hugeicons-variant'];
  return (
    <IconThemeContext
      value={{
        hugeiconsVariant: isHugeiconsVariant(hugeiconsVariant)
          ? hugeiconsVariant
          : inherited.hugeiconsVariant,
        family:
          family === 'Central' ||
          family === 'Phosphor' ||
          family === 'Lucide' ||
          family === 'Hugeicons'
            ? family
            : inherited.family,
        variant:
          variant === 'filled' || variant === 'outlined'
            ? variant
            : inherited.variant,
      }}
    >
      {children}
    </IconThemeContext>
  );
}

const IconNameContext = createContext<
  ((instance: string, name: ThemeIconName) => ThemeIconName) | null
>(null);

export type ThemeIconRenderProps = SVGProps<SVGSVGElement> & {
  name: ThemeIconName;
  family: NonNullable<ThemeDefinition['iconFamily']>;
  variant: 'filled' | 'outlined';
  weight?: number;
  hugeiconsVariant?: HugeiconsVariant;
};
const IconRendererContext = createContext<
  ((props: ThemeIconRenderProps) => ReactNode | undefined) | null
>(null);

/** Supply separately installed or licensed artwork without changing component source. */
export function IconRendererProvider({
  renderIcon,
  children,
}: {
  renderIcon: (props: ThemeIconRenderProps) => ReactNode | undefined;
  children: ReactNode;
}) {
  return (
    <IconRendererContext value={renderIcon}>{children}</IconRendererContext>
  );
}

/** Optional instance-level name resolution; ordinary icons need no provider. */
export function IconNameProvider({
  resolveName,
  children,
}: {
  resolveName: (instance: string, name: ThemeIconName) => ThemeIconName;
  children: ReactNode;
}) {
  return <IconNameContext value={resolveName}>{children}</IconNameContext>;
}

/** Decorative artwork; the containing control owns its accessible name. */
export function ThemedIcon({
  name: authoredName,
  family: explicitFamily,
  centralStyle,
  variant,
  weight,
  semantic = false,
  style,
  ...props
}: SVGProps<SVGSVGElement> & {
  name: ThemeIconName;
  family?: ThemeDefinition['iconFamily'];
  centralStyle?: 'filled' | 'outlined';
  variant?: 'filled' | 'outlined';
  weight?: number;
  /** Fixed control meaning; editor icon replacement applies only to decorative icons. */
  semantic?: boolean;
}) {
  const inherited = useContext(IconThemeContext);
  const renderIcon = useContext(IconRendererContext);
  const family = explicitFamily ?? inherited.family ?? 'Hugeicons';
  const instance = useId();
  const resolveName = useContext(IconNameContext);
  const name =
    (!semantic && resolveName?.(instance, authoredName)) || authoredName;
  const identity = {
    'data-icon-name': name,
    ...(!semantic && { 'data-icon-instance': instance }),
  };
  const Icon = allIcons[name];
  const resolvedStyle =
    variant ??
    centralStyle ??
    inherited.variant ??
    (family === 'Central' ? 'filled' : 'outlined');
  const iconStyle = {
    ...(weight !== undefined && iconWeightVariables(weight)),
    ...style,
  } as CSSProperties;
  const customIcon = renderIcon?.({
    'aria-hidden': true,
    ...props,
    ...identity,
    style: iconStyle,
    name,
    family,
    variant: resolvedStyle,
    hugeiconsVariant: inherited.hugeiconsVariant,
    weight,
  });
  if (customIcon !== undefined) return customIcon;
  const outlined = (
    <Icon
      aria-hidden="true"
      data-icon-family="Hugeicons"
      data-icon-style="outlined"
      data-icon-fallback={
        family !== 'Hugeicons' || resolvedStyle !== 'outlined' || undefined
      }
      strokeWidth="var(--icon-stroke-width, 2)"
      {...props}
      {...identity}
      style={iconStyle}
    />
  );
  // A receiving app supplies its own licensed renderer; never substitute Phosphor.
  if (family === 'Hugeicons') return outlined;
  if (family === 'Lucide')
    return resolvedStyle === 'filled' && lucideFills[name] ? (
      <FilledLucideIcon
        name={name}
        {...props}
        {...identity}
        style={iconStyle}
      />
    ) : (
      outlined
    );
  const centralOutline = family === 'Central' && resolvedStyle === 'outlined';
  const artwork = centralOutline
    ? centralOutlines[name]
    : family === 'Central'
      ? centralFills[name]
      : phosphorArtwork[name];
  if (!artwork) return outlined;
  const filledPhosphor = family === 'Phosphor' && resolvedStyle === 'filled';
  const controlStroke =
    family === 'Central' ? CENTRAL_CONTROL_STROKES[name] : undefined;
  // These strings are the static, bundled SVG catalog above, never user content.
  return (
    <svg
      width="24"
      height="24"
      viewBox={artwork.viewBox}
      fill={centralOutline ? 'none' : 'currentColor'}
      aria-hidden="true"
      data-icon-family={family}
      data-icon-style={resolvedStyle}
      {...props}
      {...identity}
      style={iconStyle}
    >
      {controlStroke ? (
        <path
          d={controlStroke}
          fill="none"
          stroke="currentColor"
          strokeWidth="var(--icon-stroke-width, 2)"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : filledPhosphor ? (
        <g
          dangerouslySetInnerHTML={{
            __html: phosphorArtwork[name].filledBody,
          }}
        />
      ) : (
        <>
          {family === 'Phosphor' && (
            <g
              style={{ display: 'var(--theme-icon-thin-display, none)' }}
              dangerouslySetInnerHTML={{
                __html: phosphorArtwork[name].thinBody,
              }}
            />
          )}
          <g
            style={{ display: 'var(--icon-light-display, none)' }}
            dangerouslySetInnerHTML={{ __html: artwork.lightBody }}
          />
          <g
            style={{ display: 'var(--icon-regular-display, inline)' }}
            dangerouslySetInnerHTML={{ __html: artwork.body }}
          />
          <g
            style={{ display: 'var(--icon-bold-display, none)' }}
            dangerouslySetInnerHTML={{ __html: artwork.boldBody }}
          />
        </>
      )}
    </svg>
  );
}

/** Filled Lucide adaptations retain transparent details instead of painting white. */
function FilledLucideIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & {
  name: ThemeIconName;
}) {
  const maskId = useId();
  const artwork = lucideFills[name];
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      data-icon-family="Lucide"
      data-icon-style="filled"
      {...props}
    >
      {artwork.cutouts && (
        <defs>
          <mask
            id={maskId}
            x="0"
            y="0"
            width="24"
            height="24"
            maskUnits="userSpaceOnUse"
            style={{ maskType: 'luminance' }}
          >
            <rect width="24" height="24" fill="white" />
            <g
              fill="black"
              style={{ color: 'black' }}
              dangerouslySetInnerHTML={{ __html: artwork.cutouts }}
            />
          </mask>
        </defs>
      )}
      <g
        mask={artwork.cutouts ? `url(#${maskId})` : undefined}
        dangerouslySetInnerHTML={{ __html: artwork.body }}
      />
    </svg>
  );
}
