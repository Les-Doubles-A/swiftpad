pub fn init<F: Fn(&tauri::AppHandle, Vec<String>, String) + Send + Sync + 'static>(_f: F) -> tauri::TauriPlugin { tauri::TauriPlugin }
