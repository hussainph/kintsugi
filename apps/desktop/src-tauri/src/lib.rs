mod ai;
mod config;
mod phone;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(vault::Vault::default())
        .manage(ai::Ai::default())
        .manage(phone::Phone::default())
        .setup(|app| {
            phone::restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_current,
            vault::vault_open,
            vault::vault_tree,
            vault::doc_read,
            vault::doc_write,
            vault::doc_create,
            vault::folder_create,
            vault::entry_rename,
            vault::entry_trash,
            vault::clip_list,
            vault::clip_read,
            vault::clip_create,
            vault::clip_update,
            vault::clip_trash,
            ai::ai_providers,
            ai::ai_stream,
            ai::ai_cancel,
            phone::phone_status,
            phone::phone_enable,
            phone::phone_reset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
