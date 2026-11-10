//! Session (onglets ouverts) et copies de récupération des modifications
//! non enregistrées. Tout reste dans le dossier de données local de
//! l'utilisateur ; rien n'est écrit si l'option correspondante est désactivée
//! (contrôle fait par l'interface, et purge immédiate à la désactivation).

use crate::error::{io_error, ApiError, ApiResult};
use crate::json::{Json, Obj};
use crate::paths;
use std::fs;
use std::path::{Path, PathBuf};

/// Taille maximale d'un fichier de session (protection).
const SESSION_MAX: usize = 4 * 1024 * 1024;
/// Taille maximale d'une copie de récupération.
pub const RECOVERY_MAX: usize = 64 * 1024 * 1024;

pub fn session_load(path: &Path) -> Json {
    match fs::read(path) {
        Ok(b) if b.len() <= SESSION_MAX => match Json::parse_bytes(&b) {
            Ok(v @ Json::Obj(_)) => v,
            _ => {
                // Session illisible : mise de côté, démarrage à vide.
                let _ = fs::rename(path, path.with_extension("corrupt.json"));
                Json::Null
            }
        },
        _ => Json::Null,
    }
}

pub fn session_save(path: &Path, session: &Json) -> ApiResult<()> {
    if !matches!(session, Json::Obj(_)) {
        return Err(ApiError::invalid_args("Session invalide."));
    }
    let text = session.to_string();
    if text.len() > SESSION_MAX {
        return Err(ApiError::invalid_args("Session trop volumineuse."));
    }
    crate::textfile::write_atomic(path, text.as_bytes())
}

pub fn session_clear(path: &Path) -> ApiResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(&e, path)),
    }
}

/// Identifiant de copie : lettres, chiffres, « - » et « _ » (pas de chemin).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn files_for(dir: &Path, id: &str) -> ApiResult<(PathBuf, PathBuf)> {
    if !valid_id(id) {
        return Err(ApiError::invalid_args("Identifiant de récupération invalide."));
    }
    Ok((dir.join(format!("{id}.txt")), dir.join(format!("{id}.json"))))
}

pub fn recovery_write(dir: &Path, id: &str, meta: &Json, text: &[u8]) -> ApiResult<()> {
    if text.len() > RECOVERY_MAX {
        return Err(ApiError::new("too_large", "Document trop volumineux pour la copie de récupération."));
    }
    let (txt, js) = files_for(dir, id)?;
    fs::create_dir_all(dir).map_err(|e| io_error(&e, dir))?;
    crate::textfile::write_atomic(&txt, text)?;
    let mut m = meta.clone();
    if !matches!(m, Json::Obj(_)) {
        m = Json::obj();
    }
    m.set("id", id);
    m.set("savedAt", crate::time::now_ms());
    m.set("length", text.len());
    crate::textfile::write_atomic(&js, m.to_string().as_bytes())
}

pub fn recovery_read(dir: &Path, id: &str) -> ApiResult<Vec<u8>> {
    let (txt, _) = files_for(dir, id)?;
    fs::read(&txt).map_err(|e| io_error(&e, &txt))
}

pub fn recovery_delete(dir: &Path, id: &str) -> ApiResult<()> {
    let (txt, js) = files_for(dir, id)?;
    for p in [js, txt] {
        match fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(&e, &p)),
        }
    }
    Ok(())
}

/// Copies disponibles (métadonnées seulement ; le texte se lit à la demande).
pub fn recovery_list(dir: &Path) -> Json {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json") else { continue };
            if !valid_id(id) || !dir.join(format!("{id}.txt")).exists() {
                continue;
            }
            if let Ok(b) = fs::read(e.path()) {
                if let Ok(m @ Json::Obj(_)) = Json::parse_bytes(&b) {
                    out.push(m);
                }
            }
        }
    }
    Json::Arr(out)
}

/// Supprime toutes les copies (option désactivée ou demande explicite).
pub fn recovery_purge(dir: &Path) -> ApiResult<usize> {
    let mut n = 0;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".txt") || name.ends_with(".json") || name.ends_with(".tmp") {
                fs::remove_file(e.path()).map_err(|err| io_error(&err, &e.path()))?;
                n += 1;
            }
        }
    }
    Ok(n)
}

/// Résumé lisible des données locales (affiché dans les préférences).
pub fn describe(config_dir: &Path, data_dir: &Path) -> Json {
    Obj::new()
        .put("configDir", paths::display(config_dir))
        .put("dataDir", paths::display(data_dir))
        .put("settingsFile", paths::display(&config_dir.join("settings.json")))
        .put("sessionFile", paths::display(&config_dir.join("session.json")))
        .put("recoveryDir", paths::display(&data_dir.join("recovery")))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn session_roundtrip_and_corruption() {
        let d = TempDir::new("store");
        let p = d.join("session.json");
        assert!(session_load(&p).is_null());
        let s = Obj::new().put("active", 1u32).put("tabs", Json::Arr(vec![])).build();
        session_save(&p, &s).unwrap();
        assert_eq!(session_load(&p), s);
        fs::write(&p, "{cassé").unwrap();
        assert!(session_load(&p).is_null());
        assert!(d.join("session.corrupt.json").exists());
        assert!(session_save(&p, &Json::from(3u32)).is_err());
        session_clear(&p).unwrap();
        session_clear(&p).unwrap();
    }

    #[test]
    fn recovery_lifecycle() {
        let d = TempDir::new("store");
        let dir = d.join("recovery");
        let meta = Obj::new().put("path", "C:\\x.txt").put("title", "x.txt").build();
        recovery_write(&dir, "doc-1", &meta, "brouillon é".as_bytes()).unwrap();
        recovery_write(&dir, "doc_2", &Json::Null, b"b").unwrap();
        let list = recovery_list(&dir);
        let arr = list.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0].str_of("title"), Some("x.txt"));
        assert_eq!(arr[0].u64_of("length"), Some("brouillon é".len() as u64));
        assert_eq!(recovery_read(&dir, "doc-1").unwrap(), "brouillon é".as_bytes());
        recovery_delete(&dir, "doc-1").unwrap();
        assert_eq!(recovery_list(&dir).as_array().unwrap().len(), 1);
        assert_eq!(recovery_purge(&dir).unwrap(), 2);
        assert!(recovery_list(&dir).as_array().unwrap().is_empty());
    }

    #[test]
    fn ids_cannot_escape_directory() {
        let d = TempDir::new("store");
        for bad in ["../x", "a/b", "a\\b", "", "x.txt", &"a".repeat(65)] {
            assert!(recovery_write(d.path(), bad, &Json::Null, b"x").is_err(), "{bad}");
            assert!(recovery_read(d.path(), bad).is_err());
        }
    }
}
