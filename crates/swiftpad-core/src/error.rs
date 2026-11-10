//! Erreurs exposées à l'interface : un code stable (pour la logique) et un
//! message en français (pour l'utilisateur).

use crate::json::{Json, Obj};
use std::fmt;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub detail: Option<Json>,
}

impl ApiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        ApiError { code, message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: Json) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn invalid_args(msg: impl Into<String>) -> Self {
        ApiError::new("invalid_args", msg)
    }

    pub fn cancelled() -> Self {
        ApiError::new("cancelled", "Opération annulée.")
    }

    pub fn to_json(&self) -> Json {
        Obj::new()
            .put("code", self.code)
            .put("message", self.message.clone())
            .put("detail", self.detail.clone().unwrap_or(Json::Null))
            .build()
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

/// Classe une erreur d'entrée/sortie en (code, raison lisible).
pub fn classify(err: &io::Error) -> (&'static str, &'static str) {
    if let Some(raw) = err.raw_os_error() {
        if let Some(c) = classify_os(raw) {
            return c;
        }
    }
    match err.kind() {
        io::ErrorKind::NotFound => ("not_found", "Fichier ou dossier introuvable"),
        io::ErrorKind::PermissionDenied => ("access_denied", "Accès refusé"),
        io::ErrorKind::AlreadyExists => ("already_exists", "Un élément portant ce nom existe déjà"),
        io::ErrorKind::InvalidInput => ("invalid_name", "Nom ou chemin non valide"),
        io::ErrorKind::UnexpectedEof => ("io", "Fin de fichier inattendue"),
        io::ErrorKind::Interrupted => ("io", "Opération interrompue"),
        _ => ("io", "Erreur d'entrée/sortie"),
    }
}

#[cfg(windows)]
fn classify_os(code: i32) -> Option<(&'static str, &'static str)> {
    // Codes Win32 (winerror.h).
    Some(match code {
        2 | 3 => ("not_found", "Fichier ou dossier introuvable"),
        5 | 1920 => ("access_denied", "Accès refusé"),
        19 => ("readonly_media", "Le support est protégé en écriture"),
        21 => ("not_ready", "Le périphérique n'est pas prêt"),
        32 => ("locked", "Le fichier est utilisé par un autre programme"),
        33 => ("locked", "Une partie du fichier est verrouillée par un autre programme"),
        1224 => ("locked", "Le fichier est ouvert (section mappée) par un autre programme"),
        1175 | 1176 => ("locked", "Le fichier d'origine est verrouillé par un autre programme ; il n'a pas été modifié"),
        1177 => ("io", "Le remplacement du fichier a échoué ; le contenu d'origine a été restauré"),
        15 | 1005 | 1006 => ("not_ready", "Le volume n'est pas accessible"),
        39 | 112 => ("disk_full", "Espace disque insuffisant"),
        53 | 67 | 64 | 59 => ("network", "Chemin réseau introuvable ou indisponible"),
        80 | 183 => ("already_exists", "Un élément portant ce nom existe déjà"),
        123 => ("invalid_name", "Nom de fichier, de dossier ou de volume incorrect"),
        161 => ("invalid_name", "Chemin non valide"),
        206 => ("path_too_long", "Nom de fichier ou chemin trop long"),
        145 => ("not_empty", "Le dossier n'est pas vide"),
        17 => ("cross_device", "Impossible de déplacer vers un autre lecteur"),
        267 => ("not_directory", "Ce n'est pas un dossier"),
        225 | 226 => ("blocked", "Opération bloquée par l'antivirus"),
        1392 => ("corrupt", "Le fichier ou le dossier est endommagé"),
        _ => return None,
    })
}

#[cfg(unix)]
fn classify_os(code: i32) -> Option<(&'static str, &'static str)> {
    // errno Linux (les valeurs usuelles sont identiques sur macOS sauf ENOTEMPTY/ELOOP).
    Some(match code {
        2 => ("not_found", "Fichier ou dossier introuvable"),
        1 | 13 => ("access_denied", "Accès refusé"),
        28 | 122 => ("disk_full", "Espace disque insuffisant"),
        17 => ("already_exists", "Un élément portant ce nom existe déjà"),
        30 => ("readonly_media", "Le système de fichiers est en lecture seule"),
        36 => ("path_too_long", "Nom de fichier ou chemin trop long"),
        39 | 66 => ("not_empty", "Le dossier n'est pas vide"),
        18 => ("cross_device", "Impossible de déplacer vers un autre volume"),
        20 => ("not_directory", "Ce n'est pas un dossier"),
        21 => ("is_directory", "C'est un dossier"),
        26 | 16 => ("locked", "Le fichier est utilisé par un autre programme"),
        40 | 62 => ("link_loop", "Trop de niveaux de liens symboliques"),
        _ => return None,
    })
}

#[cfg(not(any(windows, unix)))]
fn classify_os(_code: i32) -> Option<(&'static str, &'static str)> {
    None
}

/// Convertit une erreur d'E/S en erreur d'API avec le chemin concerné.
pub fn io_error(err: &io::Error, path: &Path) -> ApiError {
    let (code, reason) = classify(err);
    let shown = crate::paths::display(path);
    ApiError::new(code, format!("{reason} : « {shown} »."))
        .with_detail(Obj::new().put("path", shown).put("os", err.to_string()).build())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_kinds() {
        let e = io::Error::from(io::ErrorKind::NotFound);
        assert_eq!(classify(&e).0, "not_found");
        let e = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(classify(&e).0, "access_denied");
    }

    #[cfg(unix)]
    #[test]
    fn classify_errno() {
        assert_eq!(classify(&io::Error::from_raw_os_error(28)).0, "disk_full");
        assert_eq!(classify(&io::Error::from_raw_os_error(13)).0, "access_denied");
        assert_eq!(classify(&io::Error::from_raw_os_error(18)).0, "cross_device");
        assert_eq!(classify(&io::Error::from_raw_os_error(30)).0, "readonly_media");
    }

    #[test]
    fn json_shape() {
        let e = ApiError::new("conflict", "x").with_detail(Obj::new().put("a", 1u32).build());
        let j = e.to_json();
        assert_eq!(j.str_of("code"), Some("conflict"));
        assert_eq!(j.get("detail").unwrap().u64_of("a"), Some(1));
        let p = std::path::PathBuf::from("/tmp/x y");
        let a = io_error(&io::Error::from(io::ErrorKind::NotFound), &p);
        assert!(a.message.contains("/tmp/x y"));
    }
}
