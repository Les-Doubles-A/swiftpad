//! Outils de test partagés (dossiers temporaires auto-nettoyés).
//! Compilé dans la bibliothèque pour être utilisable par les tests
//! d'intégration ; sans effet sur l'application.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(prefix: &str) -> TempDir {
        let base = std::env::var_os("SWIFTPAD_TEST_TMP").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = base.join(format!("swiftpad-{prefix}-{}-{nanos}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).expect("création du dossier temporaire");
        TempDir(p)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, p: impl AsRef<Path>) -> PathBuf {
        self.0.join(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Rend tout de nouveau modifiable (certains tests retirent des droits).
        #[cfg(unix)]
        fn unlock(p: &Path) {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::symlink_metadata(p) {
                if meta.file_type().is_symlink() {
                    return;
                }
                let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(if meta.is_dir() { 0o755 } else { 0o644 }));
                if meta.is_dir() {
                    if let Ok(rd) = std::fs::read_dir(p) {
                        for e in rd.flatten() {
                            unlock(&e.path());
                        }
                    }
                }
            }
        }
        #[cfg(unix)]
        unlock(&self.0);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
