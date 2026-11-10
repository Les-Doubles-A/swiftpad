//! Paramètres : schéma versionné, validation champ par champ, valeurs par
//! défaut, tolérance aux fichiers absents ou corrompus.
//!
//! Règles :
//! * un champ invalide reprend sa valeur par défaut, les autres sont gardés ;
//! * un fichier illisible (JSON corrompu) est mis de côté sous un autre nom
//!   (jamais supprimé) et l'application démarre avec les valeurs par défaut ;
//! * les clés inconnues sont conservées (compatibilité avec une version
//!   plus récente de SwiftPad).

use crate::error::{io_error, ApiResult};
use crate::json::{Json, Obj};
use crate::paths;
use std::path::{Path, PathBuf};

pub const VERSION: u64 = 1;

enum Rule {
    Bool(bool),
    Int { def: i64, min: i64, max: i64 },
    OptInt { min: i64, max: i64 },
    Str { def: &'static str, choices: &'static [&'static str], max_len: usize },
    OptStr { max_len: usize },
    StrList { def: &'static [&'static str], max_items: usize, max_len: usize },
    /// Couleur « #rrggbb » facultative (null : couleur du thème).
    OptColor,
}

/// Police d'écriture par défaut : Constantia, conçue pour la lecture à
/// l'écran et fournie avec Windows ; repli sur d'autres serifs système.
const FONT_DEFAULT: &str = "Constantia, Cambria, Georgia, serif";

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

const SCHEMA: &[(&str, Rule)] = &[
    ("theme", Rule::Str { def: "system", choices: &["system", "light", "dark", "sepia"], max_len: 10 }),
    ("editor.fontFamily", Rule::Str { def: FONT_DEFAULT, choices: &[], max_len: 300 }),
    ("editor.fontSize", Rule::Int { def: 17, min: 6, max: 72 }),
    // Interligne en pourcentage de la taille du texte.
    ("editor.lineHeight", Rule::Int { def: 165, min: 100, max: 250 }),
    // Largeur de la colonne d'écriture (centrée) : étroite, moyenne, pleine.
    ("editor.columnWidth", Rule::Str { def: "medium", choices: &["narrow", "medium", "full"], max_len: 10 }),
    ("editor.wordWrap", Rule::Bool(true)),
    ("editor.lineNumbers", Rule::Bool(false)),
    ("editor.tabSize", Rule::Int { def: 4, min: 1, max: 16 }),
    ("editor.insertSpaces", Rule::Bool(false)),
    ("editor.showInvisibles", Rule::Bool(false)),
    ("editor.highlightTrailing", Rule::Bool(false)),
    ("editor.zoom", Rule::Int { def: 100, min: 25, max: 500 }),
    ("editor.autoIndent", Rule::Bool(true)),
    // Couleurs libres de la zone d'écriture (null : couleurs du thème).
    ("colors.background", Rule::OptColor),
    ("colors.text", Rule::OptColor),
    ("colors.caret", Rule::OptColor),
    ("ui.statusBar", Rule::Bool(false)),
    ("ui.reduceMotion", Rule::Bool(false)),
    ("window.width", Rule::Int { def: 1100, min: 400, max: 16384 }),
    ("window.height", Rule::Int { def: 720, min: 300, max: 16384 }),
    ("window.x", Rule::OptInt { min: -32768, max: 32767 }),
    ("window.y", Rule::OptInt { min: -32768, max: 32767 }),
    ("window.maximized", Rule::Bool(false)),
    // Dossier proposé par les boîtes Ouvrir / Enregistrer sous (dernier utilisé).
    ("files.workingDir", Rule::OptStr { max_len: 4096 }),
    ("files.recent", Rule::StrList { def: &[], max_items: 30, max_len: 4096 }),
    ("files.defaultEncoding", Rule::Str { def: "utf-8", choices: &["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "windows-1252"], max_len: 20 }),
    ("files.defaultEol", Rule::Str { def: "crlf", choices: &["crlf", "lf", "cr"], max_len: 4 }),
    // Seuils mesurés (voir docs/benchmarks.md) : au-delà de fluidEditMB, la
    // zone de texte native devient lente à la frappe (latence médiane ≈ 31 ms
    // à 1 Mo, ≈ 68 ms à 2 Mo sur la machine de mesure) ; le fichier s'ouvre
    // en lecture rapide, l'édition restant possible sur demande jusqu'à
    // maxEditMB. Réglable dans les préférences.
    ("files.fluidEditMB", Rule::Int { def: 1, min: 1, max: 64 }),
    ("files.maxEditMB", Rule::Int { def: 16, min: 1, max: 512 }),
    ("session.restore", Rule::Bool(true)),
    ("session.recovery", Rule::Bool(true)),
    ("session.hotExit", Rule::Bool(false)),
    ("session.recoveryNoticeSeen", Rule::Bool(false)),
    ("markdown.defaultView", Rule::Str { def: "source", choices: &["source", "split", "preview"], max_len: 10 }),
    ("markdown.toc", Rule::Bool(false)),
];

fn get_path<'a>(root: &'a Json, dotted: &str) -> Option<&'a Json> {
    let mut cur = root;
    for part in dotted.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur)
}

fn set_path(root: &mut Json, dotted: &str, value: Json) {
    let parts: Vec<&str> = dotted.split('.').collect();
    let mut cur = root;
    for part in &parts[..parts.len() - 1] {
        if !matches!(cur.get(part), Some(Json::Obj(_))) {
            cur.set(part, Json::obj());
        }
        cur = cur.get_mut(part).expect("objet créé juste avant");
    }
    cur.set(parts[parts.len() - 1], value);
}

fn default_of(rule: &Rule) -> Json {
    match rule {
        Rule::Bool(b) => Json::Bool(*b),
        Rule::Int { def, .. } => Json::from(*def),
        Rule::OptInt { .. } | Rule::OptStr { .. } | Rule::OptColor => Json::Null,
        Rule::Str { def, .. } => Json::from(*def),
        Rule::StrList { def, .. } => Json::Arr(def.iter().map(|s| Json::from(*s)).collect()),
    }
}

/// Valide une valeur ; `None` si elle est inutilisable.
fn check(rule: &Rule, v: &Json) -> Option<Json> {
    match rule {
        Rule::Bool(_) => v.as_bool().map(Json::Bool),
        Rule::Int { min, max, .. } => v.as_f64().map(|n| Json::from((n.round() as i64).clamp(*min, *max))),
        Rule::OptInt { min, max } => {
            if v.is_null() {
                Some(Json::Null)
            } else {
                v.as_f64().map(|n| Json::from((n.round() as i64).clamp(*min, *max)))
            }
        }
        Rule::Str { choices, max_len, .. } => {
            let s = v.as_str()?;
            if s.chars().count() > *max_len || s.contains('\0') {
                return None;
            }
            if !choices.is_empty() && !choices.contains(&s) {
                return None;
            }
            Some(Json::from(s))
        }
        Rule::OptStr { max_len } => {
            if v.is_null() {
                return Some(Json::Null);
            }
            let s = v.as_str()?;
            if s.is_empty() || s.chars().count() > *max_len || s.contains('\0') {
                return None;
            }
            Some(Json::from(s))
        }
        Rule::OptColor => {
            if v.is_null() {
                return Some(Json::Null);
            }
            let s = v.as_str()?;
            is_hex_color(s).then(|| Json::from(s.to_ascii_lowercase()))
        }
        Rule::StrList { max_items, max_len, .. } => {
            let arr = v.as_array()?;
            let mut out: Vec<Json> = Vec::new();
            for item in arr {
                if let Some(s) = item.as_str() {
                    if !s.is_empty() && s.chars().count() <= *max_len && !s.contains('\0') && !out.iter().any(|o| o.as_str() == Some(s)) {
                        out.push(Json::from(s));
                    }
                }
                if out.len() >= *max_items {
                    break;
                }
            }
            Some(Json::Arr(out))
        }
    }
}

pub fn defaults() -> Json {
    let mut root = Obj::new().put("version", VERSION).build();
    for (path, rule) in SCHEMA {
        set_path(&mut root, path, default_of(rule));
    }
    root
}

/// Migrations entre versions du schéma (aucune pour l'instant).
fn migrate(mut raw: Json) -> Json {
    let v = raw.u64_of("version").unwrap_or(0);
    if v < 1 {
        // Version 0 (ou absente) : même structure que la version 1.
        raw.set("version", VERSION);
    }
    raw
}

/// Paramètres validés et liste des champs corrigés.
pub fn sanitize(raw: &Json) -> (Json, Vec<String>) {
    let mut warnings = Vec::new();
    let base = match raw {
        Json::Obj(_) => migrate(raw.clone()),
        _ => {
            warnings.push("racine".to_string());
            Json::obj()
        }
    };
    let mut out = base.clone();
    for (path, rule) in SCHEMA {
        let value = match get_path(&base, path) {
            None => default_of(rule),
            Some(v) => match check(rule, v) {
                Some(ok) => ok,
                None => {
                    warnings.push(path.to_string());
                    default_of(rule)
                }
            },
        };
        set_path(&mut out, path, value);
    }
    let version = base.u64_of("version").unwrap_or(VERSION).max(VERSION);
    out.set("version", version);
    (out, warnings)
}

pub struct Loaded {
    pub settings: Json,
    /// Information à afficher une fois (fichier corrompu mis de côté…).
    pub notice: Option<Json>,
}

pub fn load(path: &Path) -> Loaded {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded { settings: defaults(), notice: None },
        Err(e) => {
            let err = io_error(&e, path);
            return Loaded {
                settings: defaults(),
                notice: Some(Obj::new().put("kind", "unreadable").put("message", format!("Paramètres illisibles, valeurs par défaut utilisées. {}", err.message)).build()),
            };
        }
    };
    match Json::parse_bytes(&bytes) {
        Ok(raw @ Json::Obj(_)) => {
            let (settings, warnings) = sanitize(&raw);
            let notice = if warnings.is_empty() {
                None
            } else {
                Some(
                    Obj::new()
                        .put("kind", "fixed")
                        .put("fields", warnings.clone())
                        .put("message", format!("Paramètres invalides remplacés par leur valeur par défaut : {}.", warnings.join(", ")))
                        .build(),
                )
            };
            Loaded { settings, notice }
        }
        _ => {
            let backup = corrupt_backup_path(path);
            let moved = std::fs::rename(path, &backup).is_ok();
            Loaded {
                settings: defaults(),
                notice: Some(
                    Obj::new()
                        .put("kind", "corrupt")
                        .put("backup", if moved { Some(paths::display(&backup)) } else { None })
                        .put(
                            "message",
                            if moved {
                                format!("Le fichier de paramètres était endommagé ; il a été conservé sous « {} » et les valeurs par défaut sont utilisées.", paths::file_name_lossy(&backup))
                            } else {
                                "Le fichier de paramètres est endommagé ; les valeurs par défaut sont utilisées.".to_string()
                            },
                        )
                        .build(),
                ),
            }
        }
    }
}

fn corrupt_backup_path(path: &Path) -> PathBuf {
    let stamp = crate::time::compact_utc(crate::time::now_ms());
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "settings".into());
    path.with_file_name(format!("{stem}.corrupt-{stamp}.json"))
}

/// Valide puis écrit les paramètres reçus de l'interface. Les clés
/// inconnues déjà présentes sur disque sont conservées. La géométrie de la
/// fenêtre (`window.*`) appartient à la couche native : la valeur sur disque
/// l'emporte sur celle, peut-être périmée, envoyée par l'interface.
pub fn save(path: &Path, incoming: &Json) -> ApiResult<Json> {
    let (mut clean, _) = sanitize(incoming);
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(existing @ Json::Obj(_)) = Json::parse_bytes(&bytes) {
            if let Some(win) = existing.get("window") {
                if let Some(w) = check_window(win) {
                    clean.set("window", w);
                }
            }
            if let Json::Obj(pairs) = existing {
                for (k, v) in pairs {
                    if clean.get(&k).is_none() {
                        clean.set(&k, v);
                    }
                }
            }
        }
    }
    crate::textfile::write_atomic(path, clean.to_pretty().as_bytes())?;
    Ok(clean)
}

/// Valide un objet `window` lu sur disque (mêmes règles que le schéma).
fn check_window(win: &Json) -> Option<Json> {
    let mut probe = Json::obj();
    probe.set("window", win.clone());
    let (clean, _) = sanitize(&probe);
    clean.get("window").cloned()
}

/// Modifie quelques champs (chemins pointés) et enregistre. Utilisé par la
/// couche native (géométrie de la fenêtre) sans passer par l'interface.
pub fn patch(path: &Path, changes: &[(&str, Json)]) -> ApiResult<Json> {
    let mut current = load(path).settings;
    for (k, v) in changes {
        set_path(&mut current, k, v.clone());
    }
    let (mut clean, _) = sanitize(&current);
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(Json::Obj(pairs)) = Json::parse_bytes(&bytes) {
            for (k, v) in pairs {
                if clean.get(&k).is_none() {
                    clean.set(&k, v);
                }
            }
        }
    }
    crate::textfile::write_atomic(path, clean.to_pretty().as_bytes())?;
    Ok(clean)
}

/// Lecture d'un champ pointé (« editor.fontSize »).
pub fn get<'a>(settings: &'a Json, dotted: &str) -> Option<&'a Json> {
    get_path(settings, dotted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn defaults_are_valid() {
        let d = defaults();
        let (s, w) = sanitize(&d);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s, d);
        assert_eq!(get_path(&d, "editor.fontSize").unwrap().as_i64(), Some(17));
        assert_eq!(get_path(&d, "editor.columnWidth").unwrap().as_str(), Some("medium"));
        assert!(get_path(&d, "colors.background").unwrap().is_null());
        assert_eq!(get_path(&d, "files.defaultEol").unwrap().as_str(), Some("crlf"));
    }

    #[test]
    fn invalid_fields_fall_back_individually() {
        let raw = Json::parse(r##"{"version":1,"theme":"rose","editor":{"fontSize":200,"wordWrap":"oui","tabSize":2,"lineHeight":20,"columnWidth":"géante"},"colors":{"background":"#1A2B3C","text":"rouge","caret":"#12345"},"ui":{"statusBar":"oui"},"files":{"recent":["a","a","",3,"b"]},"futur":{"x":1}}"##).unwrap();
        let (s, w) = sanitize(&raw);
        assert_eq!(s.str_of("theme"), Some("system"));
        assert_eq!(get_path(&s, "editor.fontSize").unwrap().as_i64(), Some(72)); // borné
        assert_eq!(get_path(&s, "editor.wordWrap").unwrap().as_bool(), Some(true));
        assert_eq!(get_path(&s, "editor.tabSize").unwrap().as_i64(), Some(2));
        assert_eq!(get_path(&s, "editor.lineHeight").unwrap().as_i64(), Some(100)); // borné
        assert_eq!(get_path(&s, "editor.columnWidth").unwrap().as_str(), Some("medium"));
        // Couleurs : format #rrggbb seulement, mis en minuscules ; sinon couleur du thème.
        assert_eq!(get_path(&s, "colors.background").unwrap().as_str(), Some("#1a2b3c"));
        assert!(get_path(&s, "colors.text").unwrap().is_null());
        assert!(get_path(&s, "colors.caret").unwrap().is_null());
        assert_eq!(get_path(&s, "ui.statusBar").unwrap().as_bool(), Some(false));
        assert_eq!(get_path(&s, "files.recent").unwrap().as_array().unwrap().len(), 2);
        assert!(s.get("futur").is_some(), "clé inconnue conservée");
        assert!(w.contains(&"theme".to_string()) && w.contains(&"editor.wordWrap".to_string()));
    }

    #[test]
    fn missing_file_gives_defaults() {
        let d = TempDir::new("set");
        let l = load(&d.join("settings.json"));
        assert!(l.notice.is_none());
        assert_eq!(l.settings, defaults());
    }

    #[test]
    fn corrupt_file_is_kept_aside() {
        let d = TempDir::new("set");
        let p = d.join("settings.json");
        std::fs::write(&p, "{ ceci n'est pas du json").unwrap();
        let l = load(&p);
        assert_eq!(l.settings, defaults());
        let n = l.notice.unwrap();
        assert_eq!(n.str_of("kind"), Some("corrupt"));
        assert!(!p.exists());
        let kept: Vec<_> = std::fs::read_dir(d.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(kept.iter().any(|n| n.starts_with("settings.corrupt-")), "{kept:?}");
    }

    #[test]
    fn save_then_load_persists_and_keeps_unknown_keys() {
        let d = TempDir::new("set");
        let p = d.join("conf/settings.json");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, r#"{"version":1,"extension":{"a":true}}"#).unwrap();
        let mut s = load(&p).settings;
        set_path(&mut s, "theme", Json::from("dark"));
        set_path(&mut s, "editor.fontSize", Json::from(18u32));
        set_path(&mut s, "window.x", Json::from(-20i64));
        s.remove("extension");
        save(&p, &s).unwrap();
        let back = load(&p).settings;
        assert_eq!(back.str_of("theme"), Some("dark"));
        assert_eq!(get_path(&back, "editor.fontSize").unwrap().as_i64(), Some(18));
        assert_eq!(get_path(&back, "window.x").unwrap().as_i64(), Some(-20));
        assert!(back.get("extension").is_some());
    }

    #[test]
    fn window_geometry_is_owned_by_native_layer() {
        let d = TempDir::new("set");
        let p = d.join("settings.json");
        patch(&p, &[("window.width", Json::from(1500u32)), ("window.maximized", Json::Bool(true))]).unwrap();
        // L'interface envoie des paramètres avec une géométrie périmée.
        let mut stale = defaults();
        set_path(&mut stale, "theme", Json::from("dark"));
        save(&p, &stale).unwrap();
        let back = load(&p).settings;
        assert_eq!(back.str_of("theme"), Some("dark"));
        assert_eq!(get(&back, "window.width").unwrap().as_i64(), Some(1500));
        assert_eq!(get(&back, "window.maximized").unwrap().as_bool(), Some(true));
        // Valeur hors bornes corrigée lors du patch.
        let s = patch(&p, &[("window.width", Json::from(10u32))]).unwrap();
        assert_eq!(get(&s, "window.width").unwrap().as_i64(), Some(400));
    }

    #[test]
    fn newer_version_is_not_downgraded() {
        let (s, _) = sanitize(&Json::parse(r#"{"version":7}"#).unwrap());
        assert_eq!(s.u64_of("version"), Some(7));
        let (s, _) = sanitize(&Json::parse(r#"{}"#).unwrap());
        assert_eq!(s.u64_of("version"), Some(VERSION));
        let (_, w) = sanitize(&Json::parse("[1]").unwrap());
        assert_eq!(w, vec!["racine".to_string()]);
    }
}
