import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentProps, ComponentType } from "react";
import {
  Add01Icon, ArrowLeft02Icon, ArrowRight01Icon, ArrowUpRight01Icon,
  Bookmark01Icon, Cancel01Icon, CheckmarkCircle02Icon, Copy01Icon,
  Delete02Icon, File01Icon, FileAddIcon, Folder01Icon, FolderAddIcon,
  ImageAdd01Icon, ImageOffIcon, InformationCircleIcon, Loading03Icon,
  QuoteDownIcon, RotateLeft01Icon, Search01Icon, SidebarLeft01Icon,
  SidebarRight01Icon, SlidersHorizontalIcon, SmartPhone01Icon,
  SparklesIcon, Tick02Icon, TriangleAlertIcon as WarningGlyph, OctagonXIcon as ErrorGlyph,
} from "@hugeicons/core-free-icons";

/** Compatibility names preserve existing consumers, not Lucide artwork. */
export type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">;
export type LucideIcon = ComponentType<IconProps>;
function glyph(icon: IconSvgElement): LucideIcon {
  // Vendor paths can carry strokeWidth; remove it so the theme's SVG-level
  // weight (including instance style overrides) remains authoritative.
  const outline = icon.map(([tag, attributes]) => {
    const { strokeWidth: _strokeWidth, ...rest } = attributes;
    return [tag, rest] as const;
  });
  return function Icon({ style, ...props }: IconProps) {
    return <HugeiconsIcon icon={outline} size={24} strokeWidth={1.5}
      aria-hidden="true" data-icon-family="Hugeicons" data-hugeicons-variant="stroke-rounded"
      {...props} style={{ strokeWidth: "var(--icon-stroke-width, 1.5)", ...style }} />;
  };
}
export const ArrowLeft = glyph(ArrowLeft02Icon);
export const ArrowUpRight = glyph(ArrowUpRight01Icon);
export const Bookmark = glyph(Bookmark01Icon);
export const Check = glyph(Tick02Icon);
export const ChevronRight = glyph(ArrowRight01Icon);
export const Copy = glyph(Copy01Icon);
export const FilePlus = glyph(FileAddIcon);
export const FileText = glyph(File01Icon);
export const Folder = glyph(Folder01Icon);
export const FolderPlus = glyph(FolderAddIcon);
export const ImageOff = glyph(ImageOffIcon);
export const ImagePlus = glyph(ImageAdd01Icon);
export const PanelLeft = glyph(SidebarLeft01Icon);
export const PanelRight = glyph(SidebarRight01Icon);
export const Plus = glyph(Add01Icon);
export const Quote = glyph(QuoteDownIcon);
export const RotateCcw = glyph(RotateLeft01Icon);
export const Search = glyph(Search01Icon);
export const SlidersHorizontal = glyph(SlidersHorizontalIcon);
export const Smartphone = glyph(SmartPhone01Icon);
export const Sparkles = glyph(SparklesIcon);
export const Trash2 = glyph(Delete02Icon);
export const X = glyph(Cancel01Icon);
export const CheckIcon = Check;
export const ChevronRightIcon = ChevronRight;
export const PanelLeftIcon = PanelLeft;
export const SearchIcon = Search;
export const XIcon = X;
export const CircleCheckIcon = glyph(CheckmarkCircle02Icon);
export const InfoIcon = glyph(InformationCircleIcon);
export const TriangleAlertIcon = glyph(WarningGlyph);
export const OctagonXIcon = glyph(ErrorGlyph);
export const Loader2Icon = glyph(Loading03Icon);
