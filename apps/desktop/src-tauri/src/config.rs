//! Kintsugi's settings: `config.json` in the app's config folder.

use kintsugi_vault::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use crate::AppHandle;
#[cfg(not(feature = "headless"))]
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    pub vault: Option<PathBuf>,
    #[serde(default)]
    pub phone: Phone,
}

/// Access to the vault from the Kintsugi phone app, over Tailscale.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Phone {
    pub enabled: bool,
    /// What a paired phone presents on every request. Resetting it unpairs.
    pub token: Option<String>,
}

/// Serializes read-modify-write cycles; commands run on several threads.
static LOCK: Mutex<()> = Mutex::new(());

/// An isolated development run never reads or persists the real app settings.
/// Release builds ignore the override entirely.
fn dev_vault() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    return std::env::var_os("KINTSUGI_VAULT").map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    None
}

pub fn isolated_dev() -> bool {
    dev_vault().is_some()
}

/// Fail closed in headless mode: even missing overrides cannot select the
/// owner's real app config. KI-7's isolated vault logic below remains shared.
pub fn directory(app: &AppHandle) -> Result<PathBuf> {
    #[cfg(feature = "headless")]
    { let _ = app; crate::headless::config_directory() }
    #[cfg(not(feature = "headless"))]
    {
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("KINTSUGI_CONFIG_DIR").filter(|p| !p.is_empty()) {
            return Ok(PathBuf::from(path));
        }
        app.path().app_config_dir().map_err(|e| e.to_string())
    }
}

fn path(app: &AppHandle) -> Result<PathBuf> {
    Ok(directory(app)?.join("config.json"))
}

pub fn load(app: &AppHandle) -> Config {
    if let Some(vault) = dev_vault() {
        return Config { vault: Some(vault), ..Config::default() };
    }
    path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn update(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<Config> {
    let _guard = LOCK.lock().unwrap();
    let mut config = load(app);
    change(&mut config);
    if isolated_dev() {
        return Ok(config);
    }
    let path = path(app)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    write_atomic(&path, &serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)?;
    Ok(config)
}
