//! Chemins : normalisation des saisies utilisateur, affichage, contrôles.
//!
//! Les fonctions « *_str » travaillent sur des chaînes et appliquent les
//! règles Windows quelle que soit la plate-forme : elles sont ainsi testées
//! sous Linux comme sous Windows.

use crate::error::{ApiError, ApiResult};
use std::path::{Component, Path, PathBuf};

/// Chemin lisible : retire les préfixes « verbatim » `\\?\` de Windows.
pub fn display(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) {
        strip_verbatim_str(&s)
    } else {
        s.into_owned()
    }
}

/// `\\?\C:\x` → `C:\x` ; `\\?\UNC\srv\share` → `\\srv\share`.
pub fn strip_verbatim_str(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            return rest.to_string();
        }
    }
    s.to_string()
}

/// Remplace les variables `%NOM%` (convention Windows). Une variable
/// inconnue est laissée telle quelle, comme le fait l'Explorateur.
pub fn expand_percent_vars(s: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 && after[..end].chars().all(|c| c.is_alphanumeric() || c == '_' || c == '(' || c == ')') => {
                let name = &after[..end];
                match lookup(name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Nettoie une saisie : espaces, guillemets entourant le chemin (copie
/// depuis l'Explorateur avec « Copier en tant que chemin d'accès »).
pub fn trim_input(s: &str) -> &str {
    let t = s.trim();
    for q in ['"', '\''] {
        if t.len() >= 2 && t.starts_with(q) && t.ends_with(q) {
            return t[1..t.len() - 1].trim();
        }
    }
    t
}

/// Normalisation lexicale : supprime `.` et résout `..` sans accéder au disque.
pub fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // Ne remonte pas au-delà de la racine.
                let can_pop = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if can_pop {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// Interprète un chemin saisi par l'utilisateur (barre d'adresse, argument
/// de ligne de commande). `base` sert aux chemins relatifs (dossier courant).
pub fn resolve_user_path(input: &str, home: Option<&Path>, base: Option<&Path>) -> ApiResult<PathBuf> {
    let t = trim_input(input);
    if t.is_empty() {
        return Err(ApiError::new("invalid_path", "Chemin vide."));
    }
    if t.contains('\0') {
        return Err(ApiError::new("invalid_path", "Le chemin contient un caractère nul."));
    }
    let mut s = expand_percent_vars(t, &|name| std::env::var(name).ok());
    if s == "~" || s.starts_with("~/") || s.starts_with("~\\") {
        if let Some(h) = home {
            s = format!("{}{}", h.to_string_lossy(), &s[1..]);
        }
    }
    if cfg!(windows) {
        s = s.replace('/', "\\");
        // « C: » seul désigne la racine du lecteur, pas son dossier courant.
        let b = s.as_bytes();
        if b.len() == 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            s.push('\\');
        }
    }
    let mut p = PathBuf::from(&s);
    if !p.is_absolute() {
        match base {
            Some(b) if !is_drive_relative_str(&s) => p = b.join(p),
            _ => {
                return Err(ApiError::new(
                    "invalid_path",
                    format!("Chemin incomplet : « {t} ». Indiquez un chemin complet, par exemple C:\\Users."),
                ))
            }
        }
    }
    let p = lexical_normalize(&p);
    check_device_path_str(&p.to_string_lossy())?;
    Ok(p)
}

/// `C:dossier` (relatif au dossier courant du lecteur) : ambigu, refusé.
pub fn is_drive_relative_str(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() && !(b.len() >= 3 && (b[2] == b'\\' || b[2] == b'/'))
}

/// Refuse l'espace de noms des périphériques (`\\.\PhysicalDrive0`,
/// `\\?\GLOBALROOT\...`) : un éditeur de texte n'a rien à y faire.
pub fn check_device_path_str(s: &str) -> ApiResult<()> {
    let lower = s.to_ascii_lowercase();
    if lower.starts_with(r"\\.\") || lower.starts_with("//./") || lower.starts_with(r"\\?\globalroot") {
        return Err(ApiError::new("invalid_path", "Les chemins de périphérique ne sont pas pris en charge."));
    }
    Ok(())
}

/// Vrai si `child` est `parent` ou se trouve à l'intérieur (comparaison par
/// composants, insensible à la casse sous Windows).
pub fn is_same_or_inside(child: &Path, parent: &Path) -> bool {
    let c: Vec<_> = child.components().collect();
    let p: Vec<_> = parent.components().collect();
    if p.len() > c.len() {
        return false;
    }
    p.iter().zip(c.iter()).all(|(a, b)| {
        if cfg!(windows) {
            a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
        } else {
            a == b
        }
    })
}

/// Égalité de chemins selon la sensibilité à la casse de la plate-forme.
pub fn same_path(a: &Path, b: &Path) -> bool {
    is_same_or_inside(a, b) && a.components().count() == b.components().count()
}

pub fn file_name_lossy(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| display(p))
}

/// Chemin canonique « affichable » (sans préfixe verbatim), si résolvable.
pub fn canonical_display(p: &Path) -> Option<String> {
    std::fs::canonicalize(p).ok().map(|c| display(&c))
}

/// Préfixe `\\?\` pour les chemins longs sous Windows (API Win32 directes).
pub fn to_verbatim_str(s: &str) -> String {
    if s.starts_with(r"\\?\") {
        return s.to_string();
    }
    if let Some(unc) = s.strip_prefix(r"\\") {
        return format!(r"\\?\UNC\{unc}");
    }
    format!(r"\\?\{s}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(strip_verbatim_str(r"\\?\C:\Users\a b"), r"C:\Users\a b");
        assert_eq!(strip_verbatim_str(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(strip_verbatim_str(r"\\?\Volume{abc}\x"), r"\\?\Volume{abc}\x");
        assert_eq!(strip_verbatim_str("/home/x"), "/home/x");
        assert_eq!(to_verbatim_str(r"C:\a"), r"\\?\C:\a");
        assert_eq!(to_verbatim_str(r"\\srv\s\a"), r"\\?\UNC\srv\s\a");
    }

    #[test]
    fn percent_vars() {
        let look = |n: &str| match n {
            "USERPROFILE" => Some(r"C:\Users\Zoé".to_string()),
            "APPDATA" => Some(r"C:\Users\Zoé\AppData\Roaming".to_string()),
            _ => None,
        };
        assert_eq!(expand_percent_vars(r"%USERPROFILE%\Documents", &look), r"C:\Users\Zoé\Documents");
        assert_eq!(expand_percent_vars("%INCONNUE%\\x", &look), "%INCONNUE%\\x");
        assert_eq!(expand_percent_vars("100% sûr", &look), "100% sûr");
        assert_eq!(expand_percent_vars("%APPDATA%%USERPROFILE%", &look), r"C:\Users\Zoé\AppData\RoamingC:\Users\Zoé");
    }

    #[test]
    fn trim_quotes() {
        assert_eq!(trim_input("  \"C:\\Mon dossier\"  "), "C:\\Mon dossier");
        assert_eq!(trim_input("'x'"), "x");
        assert_eq!(trim_input("\"x"), "\"x");
    }

    #[test]
    fn device_paths_rejected() {
        assert!(check_device_path_str(r"\\.\PhysicalDrive0").is_err());
        assert!(check_device_path_str(r"\\?\GLOBALROOT\Device\x").is_err());
        assert!(check_device_path_str(r"C:\x").is_ok());
        assert!(is_drive_relative_str("C:x"));
        assert!(!is_drive_relative_str(r"C:\x"));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_unix() {
        let home = Path::new("/home/zoé");
        assert_eq!(resolve_user_path("~/a/../b", Some(home), None).unwrap(), PathBuf::from("/home/zoé/b"));
        assert_eq!(resolve_user_path("  '/tmp/./x/'  ", None, None).unwrap(), PathBuf::from("/tmp/x"));
        assert_eq!(resolve_user_path("rel", None, Some(Path::new("/base"))).unwrap(), PathBuf::from("/base/rel"));
        assert!(resolve_user_path("rel", None, None).is_err());
        assert!(resolve_user_path("", None, None).is_err());
        assert!(resolve_user_path("/a\0b", None, None).is_err());
        assert_eq!(resolve_user_path("/../..", None, None).unwrap(), PathBuf::from("/"));
    }

    #[cfg(unix)]
    #[test]
    fn inside_checks() {
        assert!(is_same_or_inside(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(is_same_or_inside(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!is_same_or_inside(Path::new("/a/bc"), Path::new("/a/b")));
        assert!(!is_same_or_inside(Path::new("/a"), Path::new("/a/b")));
        assert!(same_path(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!same_path(Path::new("/a/b/c"), Path::new("/a/b")));
    }
}
