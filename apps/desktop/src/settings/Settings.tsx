import { useEffect, useRef } from "react";
import { ArrowLeft, Brain, FileExport, Globe, Key, Lock, Settings as SettingsIcon, Smartphone } from "@kintsugi/ui/icons";
import { Kbd } from "@kintsugi/ui/components/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@kintsugi/ui/components/sidebar";
import type { SettingsSection } from "@/lib/kin";
import type { PhoneStatus } from "@/lib/phone";
import { BlogSettings } from "./Blog";
import { ExportSettings } from "./Export";
import { GeneralSettings } from "./General";
import { ModelSettings } from "./Models";
import { PhoneSettings } from "./Phone";
import { PrivacySettings } from "./Privacy";
import { ProviderSettings } from "./Providers";

export const SECTIONS: { id: SettingsSection; label: string; icon: typeof SettingsIcon }[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "kin", label: "Kin and models", icon: Brain },
  { id: "providers", label: "Providers", icon: Key },
  { id: "phone", label: "Phone", icon: Smartphone },
  { id: "blog", label: "Blog", icon: Globe },
  { id: "export", label: "Export", icon: FileExport },
  { id: "privacy", label: "Privacy", icon: Lock },
];

type Props = {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  /** Back to where he was. */
  onClose: () => void;
  root: string | null;
  onOpenVault: () => void;
  phoneStatus: PhoneStatus | null;
  onPhoneStatus: (status: PhoneStatus) => void;
};

/** Popups and dialogs take their own Esc; Settings closes on the rest. */
const inPopup = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]');

/**
 * Settings, as a page of its own over the app: its sections down the side,
 * the chosen one on the right. The app stays as it was underneath, so Back
 * or Esc returns to it.
 */
export function Settings(props: Props) {
  const { section, onSection, onClose } = props;
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || inPopup(e.target)) return;
      const back = e.key === "Escape" || (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key === "[");
      if (!back) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  // A new section starts at its top.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [section]);

  return (
    <div className="ki-settings" role="region" aria-label="Settings" data-section={section}>
      <Sidebar collapsible="none" className="ki-settings-nav">
        <SidebarHeader className="ki-settings-nav-header" data-tauri-drag-region>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onClose} title="Back (Esc)">
                <ArrowLeft />
                <span>Back</span>
                <Kbd className="ml-auto">Esc</Kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <nav aria-label="Settings sections">
              <SidebarMenu>
                {SECTIONS.map(({ id, label, icon: Icon }) => (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton isActive={section === id} aria-current={section === id ? "page" : undefined} onClick={() => onSection(id)}>
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <main ref={main} className="ki-settings-main inspiration-scroll">
        <div className="ki-settings-drag" data-tauri-drag-region />
        {section === "general" && <GeneralSettings root={props.root} onOpenVault={props.onOpenVault} />}
        {section === "kin" && <ModelSettings />}
        {section === "providers" && <ProviderSettings />}
        {section === "phone" && <PhoneSettings status={props.phoneStatus} onStatus={props.onPhoneStatus} />}
        {section === "blog" && <BlogSettings />}
        {section === "export" && <ExportSettings />}
        {section === "privacy" && <PrivacySettings />}
      </main>
    </div>
  );
}
