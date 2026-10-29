mod ai;
mod clip_capture;
mod config;
mod enrich;
mod library;
mod navigation;
mod phone;
mod references;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("app-navigation")
            .on_navigation(|webview, url| {
                let config = webview.app_handle().config();
                let dev = if cfg!(debug_assertions) { config.build.dev_url.as_ref() } else { None };
                navigation::allowed(url, dev)
            })
            .build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(vault::Vault::default())
        .manage(library::Library::default())
        .manage(ai::Ai::default())
        .manage(enrich::Worker::default())
        .manage(phone::Phone::default())
        .setup(|app| {
            // Scratch visual reviews never start network/AI/phone services.
            if !config::isolated_dev() {
                enrich::start(app.handle());
                phone::restore(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_current,
            vault::vault_open,
            vault::vault_tree,
            references::reference_index,
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
            library::clip_search,
            library::clip_image,
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
