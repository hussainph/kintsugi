import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentProps, ComponentType } from "react";
import {
  Add01Icon, Alert01Icon, AlertCircleIcon, ArrowDown01Icon, ArrowLeft02Icon,
  ArrowRight01Icon, ArrowUpRight01Icon, AtIcon, AttachmentIcon, Bookmark01Icon,
  BookmarkAdd01Icon, BookmarkCheck01Icon, BookOpen01Icon, BubbleChatIcon, BulbIcon,
  Cancel01Icon, CheckmarkCircle02Icon, CompassIcon, Copy01Icon, Delete02Icon,
  Download01Icon, FavouriteIcon, File01Icon, FileAddIcon, FileDiffIcon, Folder01Icon,
  FolderAddIcon, HeadphonesIcon, Image01Icon, ImageAdd01Icon, ImageOffIcon,
  InformationCircleIcon, Loading03Icon, MagicWand01Icon, MessageMultiple01Icon,
  NewsIcon, Notebook01Icon, ParagraphIcon, QuoteDownIcon, RotateClockwiseIcon,
  RotateLeft01Icon, RssIcon, Search01Icon, Settings01Icon, Settings02Icon,
  SidebarLeft01Icon, SidebarRight01Icon, SlidersHorizontalIcon, SmartPhone01Icon,
  SparklesIcon, SquareIcon, Sword01Icon, Tag01Icon, Tick02Icon, Undo02Icon,
  Upload01Icon, UserCircleIcon, Video01Icon, ViewOffIcon, Brain02Icon, Key01Icon,
  Globe02Icon, LockIcon, FileExportIcon, YoutubeIcon, NewTwitterIcon, PodcastIcon,
  BrowserIcon, BookUserIcon, Link01Icon,
  TriangleAlertIcon as WarningGlyph, OctagonXIcon as ErrorGlyph,
} from "@hugeicons/core-free-icons";

/**
 * The app's icon set: Hugeicons free, stroke-rounded (MIT). Export names keep
 * the component names call sites already used.
 */
export type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">;
export type IconComponent = ComponentType<IconProps>;
function glyph(icon: IconSvgElement): IconComponent {
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
export const AlertCircle = glyph(AlertCircleIcon);
export const AlertTriangle = glyph(Alert01Icon);
export const ArrowLeft = glyph(ArrowLeft02Icon);
export const ArrowUpRight = glyph(ArrowUpRight01Icon);
export const AtSign = glyph(AtIcon);
export const Bookmark = glyph(Bookmark01Icon);
export const BookmarkCheck = glyph(BookmarkCheck01Icon);
export const BookmarkPlus = glyph(BookmarkAdd01Icon);
export const BookOpen = glyph(BookOpen01Icon);
export const BookUser = glyph(BookUserIcon);
export const Browser = glyph(BrowserIcon);
export const Brain = glyph(Brain02Icon);
export const Check = glyph(Tick02Icon);
export const ChevronDown = glyph(ArrowDown01Icon);
export const ChevronRight = glyph(ArrowRight01Icon);
export const Compass = glyph(CompassIcon);
export const Copy = glyph(Copy01Icon);
export const Download = glyph(Download01Icon);
export const FileExport = glyph(FileExportIcon);
export const EyeOff = glyph(ViewOffIcon);
export const FileDiff = glyph(FileDiffIcon);
export const FilePlus = glyph(FileAddIcon);
export const FileText = glyph(File01Icon);
export const Folder = glyph(Folder01Icon);
export const FolderPlus = glyph(FolderAddIcon);
export const Globe = glyph(Globe02Icon);
export const Headphones = glyph(HeadphonesIcon);
export const Heart = glyph(FavouriteIcon);
export const ImageIcon = glyph(Image01Icon);
export const ImageOff = glyph(ImageOffIcon);
export const ImagePlus = glyph(ImageAdd01Icon);
export const Info = glyph(InformationCircleIcon);
export const Key = glyph(Key01Icon);
export const Link = glyph(Link01Icon);
export const Lightbulb = glyph(BulbIcon);
export const Loader2 = glyph(Loading03Icon);
export const Lock = glyph(LockIcon);
export const MessageCircle = glyph(BubbleChatIcon);
export const MessagesSquare = glyph(MessageMultiple01Icon);
export const Newspaper = glyph(NewsIcon);
export const NotebookPen = glyph(Notebook01Icon);
export const PanelLeft = glyph(SidebarLeft01Icon);
export const PanelRight = glyph(SidebarRight01Icon);
export const Paperclip = glyph(AttachmentIcon);
export const Pilcrow = glyph(ParagraphIcon);
export const Plus = glyph(Add01Icon);
export const Podcast = glyph(PodcastIcon);
export const Quote = glyph(QuoteDownIcon);
export const RotateCcw = glyph(RotateLeft01Icon);
export const RotateCw = glyph(RotateClockwiseIcon);
export const Rss = glyph(RssIcon);
export const Search = glyph(Search01Icon);
export const Settings = glyph(Settings01Icon);
export const Settings2 = glyph(Settings02Icon);
export const SlidersHorizontal = glyph(SlidersHorizontalIcon);
export const Smartphone = glyph(SmartPhone01Icon);
export const Sparkles = glyph(SparklesIcon);
export const Square = glyph(SquareIcon);
export const Swords = glyph(Sword01Icon);
export const Tag = glyph(Tag01Icon);
export const Trash2 = glyph(Delete02Icon);
export const Undo2 = glyph(Undo02Icon);
export const Upload = glyph(Upload01Icon);
export const UserRound = glyph(UserCircleIcon);
export const Video = glyph(Video01Icon);
export const Wand2 = glyph(MagicWand01Icon);
export const X = glyph(Cancel01Icon);
/** The X (formerly Twitter) logo. */
export const XLogo = glyph(NewTwitterIcon);
export const YouTube = glyph(YoutubeIcon);
export const CheckIcon = Check;
export const ChevronRightIcon = ChevronRight;
export const PanelLeftIcon = PanelLeft;
export const SearchIcon = Search;
export const XIcon = X;
export const CircleCheckIcon = glyph(CheckmarkCircle02Icon);
export const InfoIcon = Info;
export const TriangleAlertIcon = glyph(WarningGlyph);
export const OctagonXIcon = glyph(ErrorGlyph);
export const Loader2Icon = Loader2;
