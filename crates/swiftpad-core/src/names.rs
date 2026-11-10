//! Règles de nommage Windows (renommage d'un document).
//!
//! Les règles Windows sont appliquées sur toutes les plates-formes : un nom
//! accepté par SwiftPad est donc toujours valide sous Windows.

use crate::error::{ApiError, ApiResult};

const FORBIDDEN: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹",
    "LPT²", "LPT³",
];

/// Vérifie qu'un nom de fichier ou de dossier est valide sous Windows.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Le nom ne peut pas être vide.".into());
    }
    if name == "." || name == ".." {
        return Err("« . » et « .. » ne sont pas des noms valides.".into());
    }
    if let Some(c) = name.chars().find(|c| FORBIDDEN.contains(c)) {
        return Err(format!("Le caractère « {c} » n'est pas autorisé (interdits : < > : \" / \\ | ? *)."));
    }
    if name.chars().any(|c| (c as u32) < 0x20) {
        return Err("Le nom contient un caractère de contrôle.".into());
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err("Le nom ne peut pas se terminer par une espace ou un point.".into());
    }
    let base = name.split('.').next().unwrap_or("").trim_end();
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(base) || r.to_lowercase() == base.to_lowercase()) {
        return Err(format!("« {base} » est un nom réservé par Windows."));
    }
    if name.encode_utf16().count() > 255 {
        return Err("Le nom est trop long (255 caractères au maximum).".into());
    }
    Ok(())
}

pub fn validate_name_api(name: &str) -> ApiResult<()> {
    validate_name(name).map_err(|m| ApiError::new("invalid_name", m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_rules() {
        for ok in ["notes.txt", "Mon fichier é.md", ".gitignore", "a", "con-tre.txt", "console", "COM10", "x.y.z"] {
            assert!(validate_name(ok).is_ok(), "{ok} devrait être valide");
        }
        for bad in ["", ".", "..", "a<b", "a:b", "a\"b", "a/b", "a\\b", "a|b", "a?b", "a*b", "fin.", "fin ", "CON", "con.txt", "Nul", "LPT1.log", "COM¹", "aux .txt", "a\u{0007}"] {
            assert!(validate_name(bad).is_err(), "{bad:?} devrait être refusé");
        }
        assert!(validate_name(&"é".repeat(256)).is_err());
        assert!(validate_name(&"é".repeat(255)).is_ok());
    }
}
