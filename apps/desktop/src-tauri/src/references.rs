//! One fresh disk snapshot powers the picker, margin and "Used in" backlinks.
//! The frontend refreshes after writing/clip mutations and vault changes.

use crate::vault::Vault;
use kintsugi_vault::{self as vault, ReferenceIndex};
use tauri::State;

#[tauri::command]
pub async fn reference_index(vault: State<'_, Vault>) -> Result<ReferenceIndex, String> {
    let root = vault.root()?;
    tauri::async_runtime::spawn_blocking(move || vault::reference_index(&root))
        .await
        .map_err(|error| error.to_string())?
}
