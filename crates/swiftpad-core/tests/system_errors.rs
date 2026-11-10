//! Tests d'intégration des erreurs système réelles.
//!
//! Ils nécessitent un environnement préparé par `scripts/test-core.sh` :
//! * `SWIFTPAD_FULL_DISK_DIR` : dossier sur un petit système de fichiers
//!   (tmpfs de 64 Ko) pour provoquer un vrai « disque plein » ;
//! * `SWIFTPAD_UNPRIVILEGED=1` : exécution sans droits d'administrateur,
//!   pour que les refus d'accès du système s'appliquent réellement.
//!
//! Sans ces variables, les tests concernés se terminent sans rien vérifier
//! (et l'indiquent sur la sortie d'erreur).

use std::fs;
use std::path::Path;
use swiftpad_core::encoding::Encoding;
use swiftpad_core::eol::Eol;
use swiftpad_core::testutil::TempDir;
use swiftpad_core::textfile::{open_text, save_text, OpenRequest, SaveRequest};
use swiftpad_core::fsops;

fn open(p: &Path) -> swiftpad_core::ApiResult<swiftpad_core::textfile::OpenedText> {
    open_text(&OpenRequest { path: p, max_bytes: 1 << 30, allow_binary: false, forced: None, default_eol: Eol::Lf, cancel: None })
}

fn leftovers(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".swiftpad-"))
        .collect()
}

#[test]
fn disk_full_keeps_original_intact() {
    let Some(dir) = std::env::var_os("SWIFTPAD_FULL_DISK_DIR") else {
        eprintln!("ignoré : SWIFTPAD_FULL_DISK_DIR non défini");
        return;
    };
    let dir = Path::new(&dir);
    let p = dir.join("journal.txt");
    fs::write(&p, "contenu d'origine\n").unwrap();
    let doc = open(&p).unwrap();
    // 1 Mo ne tient pas dans un tmpfs de 64 Ko.
    let big = "x".repeat(1024 * 1024);
    let err = save_text(&SaveRequest {
        path: &p,
        text: &big,
        encoding: Encoding::UTF8,
        eol: Eol::Lf,
        expected: Some(&doc.stamp.token()),
        force: false,
        create_new: false,
    })
    .unwrap_err();
    assert_eq!(err.code, "disk_full", "{err:?}");
    assert_eq!(fs::read_to_string(&p).unwrap(), "contenu d'origine\n", "l'original doit être intact");
    assert!(leftovers(dir).is_empty(), "fichier temporaire restant : {:?}", leftovers(dir));
    // Un petit enregistrement réussit ensuite normalement.
    save_text(&SaveRequest { path: &p, text: "petit\n", encoding: Encoding::UTF8, eol: Eol::Lf, expected: Some(&doc.stamp.token()), force: false, create_new: false })
        .unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "petit\n");
    fs::remove_file(&p).unwrap();
}

#[cfg(unix)]
mod unprivileged {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn enabled() -> bool {
        if std::env::var("SWIFTPAD_UNPRIVILEGED").is_err() {
            eprintln!("ignoré : SWIFTPAD_UNPRIVILEGED non défini");
            return false;
        }
        true
    }

    #[test]
    fn unreadable_file_and_dir_are_reported() {
        if !enabled() {
            return;
        }
        let d = TempDir::new("perm");
        let f = d.join("secret.txt");
        fs::write(&f, "x").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(open(&f).unwrap_err().code, "access_denied");
        // Fichier lisible dans un dossier fermé : la traversée est refusée.
        let sub = d.join("fermé");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("dedans.txt"), "y").unwrap();
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(open(&sub.join("dedans.txt")).unwrap_err().code, "access_denied");
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn locked_directory_refuses_rename_and_new_file() {
        if !enabled() {
            return;
        }
        let d = TempDir::new("perm");
        let locked = d.join("verrou");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("a.txt"), "a").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(fsops::rename(&locked.join("a.txt"), "b.txt").unwrap_err().code, "access_denied");
        assert!(locked.join("a.txt").exists());
        // « Enregistrer sous » un nouveau fichier dans ce dossier.
        let e = save_text(&SaveRequest { path: &locked.join("nouveau.txt"), text: "n", encoding: Encoding::UTF8, eol: Eol::Lf, expected: None, force: false, create_new: true })
            .unwrap_err();
        assert_eq!(e.code, "access_denied", "{e:?}");
        assert!(!locked.join("nouveau.txt").exists());
        assert!(leftovers(&locked).is_empty());
    }

    #[test]
    fn writable_file_in_locked_directory_is_saved_in_place() {
        if !enabled() {
            return;
        }
        let d = TempDir::new("perm");
        let locked = d.join("verrou");
        fs::create_dir(&locked).unwrap();
        let f = locked.join("notes.txt");
        fs::write(&f, "v1").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let doc = open(&f).unwrap();
        let r = save_text(&SaveRequest { path: &f, text: "v2", encoding: Encoding::UTF8, eol: Eol::Lf, expected: Some(&doc.stamp.token()), force: false, create_new: false })
            .unwrap();
        assert!(!r.atomic, "écriture sur place attendue");
        assert_eq!(fs::read_to_string(&f).unwrap(), "v2");
    }

    #[test]
    fn readonly_file_in_locked_directory_is_refused() {
        if !enabled() {
            return;
        }
        let d = TempDir::new("perm");
        let f = d.join("ro.txt");
        fs::write(&f, "v1").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o444)).unwrap();
        let doc = open(&f).unwrap();
        assert!(doc.readonly);
        let e = save_text(&SaveRequest { path: &f, text: "v2", encoding: Encoding::UTF8, eol: Eol::Lf, expected: Some(&doc.stamp.token()), force: true, create_new: false })
            .unwrap_err();
        assert_eq!(e.code, "readonly");
        assert_eq!(fs::read_to_string(&f).unwrap(), "v1");
    }
}

#[test]
fn deleted_and_moved_files_while_open() {
    let d = TempDir::new("moved");
    let p = d.join("a.txt");
    fs::write(&p, "texte").unwrap();
    let doc = open(&p).unwrap();
    // Déplacé par un autre programme : l'ancien chemin n'existe plus.
    fs::rename(&p, d.join("b.txt")).unwrap();
    let st = swiftpad_core::textfile::stat(&p);
    assert!(!st.exists);
    let e = save_text(&SaveRequest { path: &p, text: "mien", encoding: Encoding::UTF8, eol: Eol::Lf, expected: Some(&doc.stamp.token()), force: false, create_new: false })
        .unwrap_err();
    assert_eq!(e.code, "deleted");
    assert_eq!(fs::read_to_string(d.join("b.txt")).unwrap(), "texte", "le fichier déplacé n'est pas touché");
}
