// SwiftPad — couche native Tauri 2.
//
// Volontairement mince : toute la logique (fichiers, encodages, recherche,
// paramètres, récupération) est dans `swiftpad-core`, testé indépendamment.
// Cette couche fournit uniquement :
// * la commande `rpc` (requête binaire → noyau, hors du thread principal) ;
// * les boîtes de dialogue natives (Ouvrir, Enregistrer sous, Dossier) ;
// * l'Explorateur Windows (afficher, ouvrir un dossier, application par défaut
//   pour une liste fermée de types inertes) et les liens http(s)/mailto ;
// * la fenêtre : géométrie restaurée, titre, impression, fermeture protégée
//   (modifications non enregistrées), instance unique, glisser-déposer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use swiftpad_core::json::Json;
use swiftpad_core::rpc::{Config, Core, Place};
use swiftpad_core::{paths as spaths, settings};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{DragDropEvent, Emitter, Manager, Theme, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct AppState {
    core: Arc<Core>,
    /// Fermeture validée par l'interface (modifications traitées).
    allow_close: AtomicBool,
    /// Demande de fermeture en cours et accusé de réception de l'interface :
    /// si l'interface ne répond plus (erreur fatale), une seconde demande
    /// après 3 s ferme quand même la fenêtre.
    close_pending: Mutex<Option<Instant>>,
    close_acked: AtomicBool,
    /// L'interface est prête à recevoir des événements.
    ready: AtomicBool,
}

#[derive(serde::Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

/// Types inertes qu'il est acceptable de confier à l'application par défaut.
/// Aucun exécutable, script ou raccourci.
const SAFE_DEFAULT_APP_EXTS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "mp3", "mp4", "wav", "flac", "mkv", "avi", "zip", "7z",
];

fn checked_path(p: &str) -> Result<PathBuf, String> {
    if p.is_empty() || p.contains('\0') || p.len() > 32_000 {
        return Err("Chemin invalide.".into());
    }
    spaths::check_device_path_str(p).map_err(|e| e.message)?;
    let pb = PathBuf::from(p);
    if !pb.is_absolute() {
        return Err("Chemin non absolu.".into());
    }
    if !pb.exists() {
        return Err(format!("Introuvable : « {p} »."));
    }
    Ok(pb)
}

// --- noyau --------------------------------------------------------------------

/// Requête binaire de l'interface (voir crates/swiftpad-core/src/rpc.rs).
/// Exécutée sur un fil de travail : le thread de la fenêtre n'est jamais bloqué.
#[tauri::command]
async fn rpc(request: Request<'_>, state: tauri::State<'_, AppState>) -> Result<Response, String> {
    let body = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => return Err("Requête binaire attendue.".into()),
    };
    let core = state.core.clone();
    let out = tauri::async_runtime::spawn_blocking(move || core.handle(&body)).await.map_err(|e| e.to_string())?;
    Ok(Response::new(out))
}

// --- boîtes de dialogue natives ------------------------------------------------

fn with_filters<R: tauri::Runtime>(mut b: tauri_plugin_dialog::FileDialogBuilder<R>, filters: &[Filter]) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    for f in filters.iter().take(16) {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).filter(|e| !e.is_empty() && e.len() < 16).collect();
        if !exts.is_empty() {
            b = b.add_filter(f.name.clone(), &exts);
        }
    }
    b
}

#[tauri::command]
async fn dialog_open_files(window: tauri::Window, directory: Option<String>, filters: Vec<Filter>) -> Result<Option<Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = window.dialog().file().set_parent(&window).set_title("Ouvrir");
        if let Some(d) = directory.filter(|d| Path::new(d).is_dir()) {
            b = b.set_directory(d);
        }
        with_filters(b, &filters)
            .blocking_pick_files()
            .map(|list| list.into_iter().filter_map(|p| p.into_path().ok()).map(|p| spaths::display(&p)).collect())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn dialog_save_file(window: tauri::Window, directory: Option<String>, name: String, filters: Vec<Filter>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = window.dialog().file().set_parent(&window).set_title("Enregistrer sous").set_file_name(name);
        if let Some(d) = directory.filter(|d| Path::new(d).is_dir()) {
            b = b.set_directory(d);
        }
        with_filters(b, &filters).blocking_save_file().and_then(|p| p.into_path().ok()).map(|p| spaths::display(&p))
    })
    .await
    .map_err(|e| e.to_string())
}

// --- Explorateur Windows, liens -------------------------------------------------

#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = checked_path(&path)?;
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_with_default(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = checked_path(&path)?;
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !p.is_file() || !SAFE_DEFAULT_APP_EXTS.contains(&ext.as_str()) {
        return Err("Type de fichier non autorisé pour l'ouverture externe.".into());
    }
    app.opener().open_path(spaths::display(&p), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let ok_scheme = lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:");
    if !ok_scheme || url.len() > 2048 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Lien refusé (seuls http, https et mailto sont autorisés).".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// --- fenêtre ---------------------------------------------------------------------

#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_title(window: tauri::Window, title: String) -> Result<(), String> {
    let t: String = title.chars().filter(|c| !c.is_control()).take(300).collect();
    window.set_title(&t).map_err(|e| e.to_string())
}

/// Thème de la fenêtre native (barre de titre) : « system » suit Windows.
/// Appelé quand l'utilisateur change de thème (au lancement, le thème est fixé
/// à la création de la fenêtre). Renvoie le thème effectif, que l'interface
/// applique explicitement : elle ne dépend pas de la propagation de ce
/// changement à `prefers-color-scheme` dans WebView2.
#[tauri::command]
fn set_theme(window: tauri::WebviewWindow, theme: String) -> Result<String, String> {
    let t = match theme.as_str() {
        "dark" => Some(Theme::Dark),
        "light" | "sepia" => Some(Theme::Light),
        _ => None,
    };
    window.set_theme(t).map_err(|e| e.to_string())?;
    Ok(theme_name(window.theme().unwrap_or(Theme::Light)).to_string())
}

fn theme_name(t: Theme) -> &'static str {
    match t {
        Theme::Dark => "dark",
        _ => "light",
    }
}

/// Première image de l'interface dessinée : la fenêtre peut s'afficher
/// (pas de flash blanc ni de mise en page en cours).
#[tauri::command]
fn app_ready(window: tauri::Window, state: tauri::State<'_, AppState>) {
    state.ready.store(true, Ordering::SeqCst);
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn close_ack(state: tauri::State<'_, AppState>) {
    state.close_acked.store(true, Ordering::SeqCst);
}

/// L'interface a traité les modifications non enregistrées : fermeture.
#[tauri::command]
fn close_confirmed(window: tauri::Window, state: tauri::State<'_, AppState>) {
    state.allow_close.store(true, Ordering::SeqCst);
    save_geometry(&state.core, &window);
    let _ = window.close();
}

fn save_geometry(core: &Core, win: &tauri::Window) {
    let maximized = win.is_maximized().unwrap_or(false);
    let mut changes: Vec<(&str, Json)> = vec![("window.maximized", Json::Bool(maximized))];
    if !maximized && !win.is_minimized().unwrap_or(false) {
        if let (Ok(size), Ok(pos), Ok(scale)) = (win.inner_size(), win.outer_position(), win.scale_factor()) {
            let s = size.to_logical::<f64>(scale);
            let p = pos.to_logical::<f64>(scale);
            changes.push(("window.width", Json::from(s.width.round() as i64)));
            changes.push(("window.height", Json::from(s.height.round() as i64)));
            changes.push(("window.x", Json::from(p.x.round() as i64)));
            changes.push(("window.y", Json::from(p.y.round() as i64)));
        }
    }
    let _ = settings::patch(&core.settings_path(), &changes);
}

/// La position mémorisée est-elle encore sur un écran (écran débranché…) ?
fn on_screen(app: &tauri::AppHandle, x: f64, y: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let sf = m.scale_factor();
        let (mx, my) = (m.position().x as f64 / sf, m.position().y as f64 / sf);
        let (mw, mh) = (m.size().width as f64 / sf, m.size().height as f64 / sf);
        let (px, py) = (x + 80.0, y + 20.0);
        px >= mx && px < mx + mw && py >= my && py < my + mh
    })
}

fn num(s: &Json, key: &str) -> Option<f64> {
    settings::get(s, key).and_then(Json::as_f64)
}

fn main() {
    tauri::Builder::default()
        // Instance unique : un fichier ouvert depuis l'Explorateur alors que
        // SwiftPad tourne déjà s'ouvre dans un onglet de la fenêtre existante.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            // Second lancement pendant l'initialisation : état pas encore
            // enregistré, la demande est ignorée plutôt que de paniquer.
            let Some(state) = app.try_state::<AppState>() else { return };
            let files = state.core.normalize_launch_args_in(argv.into_iter().skip(1), Some(Path::new(&cwd)));
            if !files.is_empty() {
                if state.ready.load(Ordering::SeqCst) {
                    let _ = app.emit("swiftpad://open-files", files);
                } else {
                    state.core.queue_open(files);
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            rpc,
            dialog_open_files,
            dialog_save_file,
            reveal_path,
            open_with_default,
            open_url,
            print_page,
            set_title,
            set_theme,
            app_ready,
            close_ack,
            close_confirmed
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                if state.allow_close.load(Ordering::SeqCst) {
                    return;
                }
                let mut pending = state.close_pending.lock().unwrap_or_else(|e| e.into_inner());
                let unresponsive = matches!(*pending, Some(t) if t.elapsed() > Duration::from_secs(3)) && !state.close_acked.load(Ordering::SeqCst);
                if unresponsive {
                    // L'interface n'a pas répondu à la demande précédente.
                    save_geometry(&state.core, window);
                    return;
                }
                api.prevent_close();
                *pending = Some(Instant::now());
                state.close_acked.store(false, Ordering::SeqCst);
                save_geometry(&state.core, window);
                let _ = window.emit("swiftpad://close-requested", ());
            }
            // Thème de Windows modifié (suivi en mode « système »).
            WindowEvent::ThemeChanged(theme) => {
                let _ = window.emit("swiftpad://theme-changed", theme_name(*theme));
            }
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                let state = window.state::<AppState>();
                let list: Vec<String> = paths.iter().map(|p| spaths::display(p)).collect();
                if state.ready.load(Ordering::SeqCst) {
                    let _ = window.emit("swiftpad://open-files", list);
                } else {
                    state.core.queue_open(list);
                }
            }
            _ => {}
        })
        .setup(|app| {
            let resolver = app.path();
            // Profil séparé (bancs d'essai, essais) : SWIFTPAD_PROFILE_DIR
            // remplace les paramètres et la session de l'utilisateur.
            let (config_dir, data_dir) = match std::env::var_os("SWIFTPAD_PROFILE_DIR").filter(|v| !v.is_empty()) {
                Some(d) => (PathBuf::from(&d).join("config"), PathBuf::from(&d).join("data")),
                // Copies de récupération : dossier local (jamais itinérant).
                None => (resolver.app_config_dir()?, resolver.app_local_data_dir()?),
            };
            let home = resolver.home_dir().ok();
            let mut places = Vec::new();
            for (label, dir) in [("Bureau", resolver.desktop_dir()), ("Documents", resolver.document_dir()), ("Téléchargements", resolver.download_dir())] {
                if let Ok(p) = dir {
                    if p.is_dir() {
                        places.push(Place { label: label.to_string(), path: p });
                    }
                }
            }
            let mut core = Core::new(Config {
                config_dir,
                data_dir,
                home_dir: home,
                places,
                version: env!("CARGO_PKG_VERSION").to_string(),
                launch_files: Vec::new(),
                cwd: std::env::current_dir().ok(),
            });
            let launch = core.normalize_launch_args(std::env::args().skip(1));
            if let Some(c) = Arc::get_mut(&mut core) {
                c.cfg.launch_files = launch;
            }
            core.mark("setup");
            let s = core.load_settings().settings;
            let theme = match s.str_of("theme") {
                Some("dark") => Some(Theme::Dark),
                // Sépia : thème clair pour la barre de titre.
                Some("light") | Some("sepia") => Some(Theme::Light),
                _ => None,
            };
            // Données de démarrage injectées avant tout script : la première
            // image se dessine sans aller-retour. Le JSON produit par le noyau
            // échappe < > & U+2028 U+2029 : il peut être inclus tel quel.
            let boot = format!("window.__SWIFTPAD_BOOT__ = {};", core.boot());
            let width = num(&s, "window.width").unwrap_or(1100.0);
            let height = num(&s, "window.height").unwrap_or(720.0);
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("SwiftPad")
                .inner_size(width, height)
                .min_inner_size(400.0, 300.0)
                .visible(false)
                .theme(theme)
                .initialization_script(&boot);
            match (num(&s, "window.x"), num(&s, "window.y")) {
                (Some(x), Some(y)) if on_screen(app.handle(), x, y) => builder = builder.position(x, y),
                _ => builder = builder.center(),
            }
            let window = builder.build()?;
            if settings::get(&s, "window.maximized").and_then(Json::as_bool).unwrap_or(false) {
                let _ = window.maximize();
            }
            app.manage(AppState {
                core,
                allow_close: AtomicBool::new(false),
                close_pending: Mutex::new(None),
                close_acked: AtomicBool::new(false),
                ready: AtomicBool::new(false),
            });
            // Filet de sécurité : la fenêtre s'affiche même si l'interface
            // ne signale pas qu'elle est prête.
            let w = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("SwiftPad n'a pas pu démarrer");
}
