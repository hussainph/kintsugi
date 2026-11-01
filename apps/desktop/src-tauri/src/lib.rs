mod ai;
mod books;
mod clip_capture;
mod config;
mod enrich;
mod feed;
mod library;
#[cfg(not(feature = "headless"))]
mod navigation;
mod phone;
mod references;
mod search;
mod tools;
mod vault;

#[cfg(all(feature = "headless", not(debug_assertions)))]
compile_error!("headless is a debug-only development feature");
#[cfg(all(feature = "headless", feature = "native"))]
compile_error!("headless must be built with --no-default-features (no native runtime)");

#[cfg(feature = "headless")]
type Runtime = tauri::test::MockRuntime;
#[cfg(not(feature = "headless"))]
type Runtime = tauri::Wry;
type AppHandle = tauri::AppHandle<Runtime>;

#[cfg(feature = "headless")]
mod headless;

/// One registry and state setup for native and headless. New commands cannot
/// silently go missing from a second HTTP command table.
fn builder() -> tauri::Builder<Runtime> {
    #[cfg(feature = "headless")]
    let builder = tauri::test::mock_builder();
    #[cfg(not(feature = "headless"))]
    use tauri::Manager;
    #[cfg(not(feature = "headless"))]
    let builder = tauri::Builder::default()
        .plugin(tauri::plugin::Builder::<Runtime, ()>::new("app-navigation")
            .on_navigation(|webview, url| {
                // Hidden page readers load the web, never the app's origin.
                if webview.label().starts_with(enrich::render::LABEL_PREFIX) {
                    return kintsugi_ingest::web::render::allowed_navigation(url);
                }
                let config = webview.app_handle().config();
                let dev = if cfg!(debug_assertions) { config.build.dev_url.as_ref() } else { None };
                navigation::allowed(url, dev)
            })
            .build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Signed updates from GitHub Releases; see README › Releasing.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .manage(vault::Vault::default())
        .manage(library::Library::default())
        .manage(search::Search::default())
        .manage(ai::Ai::default())
        .manage(ai::Kin::default())
        .manage(ai::Chat::default())
        .manage(enrich::Worker::default())
        .manage(phone::Phone::default())
        .manage(feed::Feed::default())
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
            vault::clip_open_file,
            books::book_search,
            library::clip_search,
            library::clip_image,
            search::search,
            ai::ai_providers,
            ai::ai_stream,
            ai::ai_cancel,
            ai::kin::kin_turn,
            ai::kin::kin_cancel,
            ai::kin::kin_usage,
            ai::kin::kin_settings,
            ai::kin::kin_set_cap,
            ai::kin::kin_set_model,
            ai::about::kin_memory,
            ai::about::kin_memory_undo,
            ai::about::kin_memory_edit,
            ai::about::kin_skills,
            ai::about::kin_skill,
            ai::chat::kin_chat_send,
            ai::chat::kin_chat_typing,
            ai::chat::kin_chat_stop,
            ai::chat::kin_chat_log,
            ai::chat::kin_chat_topic,
            ai::chat::kin_chat_search,
            ai::chat::kin_job_create,
            ai::chat::kin_jobs,
            ai::chat::kin_job_cancel,
            phone::phone_status,
            phone::phone_enable,
            phone::phone_reset,
            feed::feed_sources,
            feed::feed_subscribe,
            feed::feed_unsubscribe,
            feed::feed_mute,
            feed::feed_refresh,
            feed::feed_podcast_search,
            feed::feed_opml_import,
            feed::feed_opml_export,
            feed::feed_items,
            feed::feed_read,
            feed::feed_act,
            feed::feed_note,
            feed::feed_impressions,
            feed::feed_save,
            tools::tools_list,
            tools::tools_install,
            tools::tools_update,
            tools::tools_remove,
        ])
}

#[cfg(not(feature = "headless"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    builder()
        .setup(|app| {
            ai::init(app.handle());
            // App data, not the vault, so it runs in scratch vault runs too.
            feed::start(app.handle());
            search::init(app.handle());
            if !config::isolated_dev() {
                enrich::start(app.handle());
                phone::restore(app.handle());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(feature = "headless")]
pub fn run() {
    headless::run().expect("headless backend failed");
}
