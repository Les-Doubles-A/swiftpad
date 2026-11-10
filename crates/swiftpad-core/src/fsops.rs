//! Renommage d'un document ouvert (menu Fichier ▸ Renommer).
//!
//! C'est la seule opération sur les fichiers exposée à l'interface en
//! dehors de l'ouverture et de l'enregistrement : SwiftPad n'a pas de
//! gestionnaire de fichiers (ni création, copie, déplacement ou
//! suppression). Rien n'est écrasé : un nom déjà pris est refusé.

use crate::error::{io_error, ApiError, ApiResult};
use crate::names;
use crate::paths;
use std::fs;
use std::path::{Path, PathBuf};

pub fn rename(path: &Path, new_name: &str) -> ApiResult<PathBuf> {
    names::validate_name_api(new_name)?;
    fs::symlink_metadata(path).map_err(|e| io_error(&e, path))?;
    let parent = path.parent().ok_or_else(|| ApiError::new("invalid_path", "Impossible de renommer une racine."))?;
    let dest = parent.join(new_name);
    if dest == path {
        return Ok(dest);
    }
    // Un changement de casse seul (« a.txt » → « A.txt ») désigne le même
    // fichier sous Windows : ce n'est pas un conflit.
    let case_only = paths::file_name_lossy(path).to_lowercase() == new_name.to_lowercase();
    if fs::symlink_metadata(&dest).is_ok() && !(case_only && cfg!(windows)) {
        return Err(ApiError::new("already_exists", format!("« {new_name} » existe déjà dans ce dossier.")));
    }
    fs::rename(path, &dest).map_err(|e| io_error(&e, path))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn rename_checks_names_and_conflicts() {
        let d = TempDir::new("ops");
        let f = d.join("Nouveau document.txt");
        fs::write(&f, "x").unwrap();
        let r = rename(&f, "renommé.md").unwrap();
        assert!(r.exists() && !f.exists());
        assert_eq!(fs::read_to_string(&r).unwrap(), "x");
        fs::write(d.join("autre.md"), "garder").unwrap();
        assert_eq!(rename(&r, "autre.md").unwrap_err().code, "already_exists");
        assert_eq!(fs::read_to_string(d.join("autre.md")).unwrap(), "garder", "rien n'est écrasé");
        assert_eq!(rename(&r, "CON").unwrap_err().code, "invalid_name");
        assert_eq!(rename(&r, "a:b.txt").unwrap_err().code, "invalid_name");
        assert_eq!(rename(&d.join("absent.txt"), "x.txt").unwrap_err().code, "not_found");
        assert_eq!(rename(&r, "renommé.md").unwrap(), r, "même nom : rien à faire");
    }
}
