//! Lecture et enregistrement des documents texte.
//!
//! Enregistrement : écriture dans un fichier temporaire du même dossier,
//! vidage sur disque (`sync_all`), puis remplacement atomique
//! (`ReplaceFileW` sous Windows, `rename` ailleurs). En cas d'échec à
//! n'importe quelle étape, le fichier d'origine est intact.
//!
//! Conflits : chaque document garde l'« empreinte » (date de modification
//! en nanosecondes + taille) du fichier lu. L'enregistrement est refusé si
//! le fichier a changé ou disparu depuis, sauf confirmation explicite.

use crate::encoding::{self, Charset, Confidence, Encoding};
use crate::eol::{Eol, EolStats};
use crate::error::{io_error, ApiError, ApiResult};
use crate::json::{Json, Obj};
use crate::paths;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Empreinte d'un fichier pour la détection des modifications externes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub mtime_ns: i128,
    pub size: u64,
}

impl Stamp {
    pub fn of(meta: &Metadata) -> Stamp {
        let mtime_ns = meta.modified().map(crate::time::system_time_ns).unwrap_or(0);
        Stamp { mtime_ns, size: meta.len() }
    }

    pub fn token(&self) -> String {
        format!("{}:{}", self.mtime_ns, self.size)
    }

    pub fn mtime_ms(&self) -> f64 {
        self.mtime_ns as f64 / 1_000_000.0
    }
}

#[derive(Debug, Clone)]
pub struct FileStatus {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: f64,
    pub readonly: bool,
    pub stamp: Option<String>,
}

impl FileStatus {
    pub fn to_json(&self, path: &str) -> Json {
        Obj::new()
            .put("path", path)
            .put("exists", self.exists)
            .put("isDir", self.is_dir)
            .put("size", self.size)
            .put("mtimeMs", self.mtime_ms)
            .put("readonly", self.readonly)
            .put("stamp", self.stamp.clone())
            .build()
    }
}

/// État d'un fichier, sans erreur s'il n'existe pas (contrôle au retour du focus).
pub fn stat(path: &Path) -> FileStatus {
    match fs::metadata(path) {
        Ok(m) => {
            let st = Stamp::of(&m);
            FileStatus {
                exists: true,
                is_dir: m.is_dir(),
                size: m.len(),
                mtime_ms: st.mtime_ms(),
                readonly: m.permissions().readonly(),
                stamp: Some(st.token()),
            }
        }
        Err(_) => FileStatus { exists: false, is_dir: false, size: 0, mtime_ms: 0.0, readonly: false, stamp: None },
    }
}

pub struct OpenRequest<'a> {
    pub path: &'a Path,
    pub max_bytes: u64,
    pub allow_binary: bool,
    pub forced: Option<Charset>,
    pub default_eol: Eol,
    pub cancel: Option<&'a AtomicBool>,
}

#[derive(Debug)]
pub struct OpenedText {
    pub path: String,
    pub name: String,
    pub text: String,
    pub encoding: Encoding,
    pub confidence: Confidence,
    pub replaced: usize,
    pub eol: Eol,
    pub eol_stats: EolStats,
    pub stamp: Stamp,
    pub readonly: bool,
    pub size: u64,
    pub link_target: Option<String>,
    /// Le fichier changeait pendant la lecture (journal en cours d'écriture).
    pub unstable: bool,
    /// Ouvert malgré un contenu détecté comme binaire.
    pub binary_reason: Option<&'static str>,
}

impl OpenedText {
    /// En-tête transmis à l'interface (le texte voyage à part, en octets).
    pub fn header(&self) -> Json {
        Obj::new()
            .put("path", self.path.clone())
            .put("name", self.name.clone())
            .put("encoding", self.encoding.id())
            .put("encodingLabel", self.encoding.label())
            .put("confidence", self.confidence.id())
            .put("uncertain", self.confidence.is_uncertain())
            .put("replaced", self.replaced)
            .put("eol", self.eol.id())
            .put(
                "eolStats",
                Obj::new().put("crlf", self.eol_stats.crlf).put("lf", self.eol_stats.lf).put("cr", self.eol_stats.cr).build(),
            )
            .put("eolMixed", self.eol_stats.is_mixed())
            .put("stamp", self.stamp.token())
            .put("mtimeMs", self.stamp.mtime_ms())
            .put("size", self.size)
            .put("readonly", self.readonly)
            .put("linkTarget", self.link_target.clone())
            .put("unstable", self.unstable)
            .put("binaryReason", self.binary_reason)
            .build()
    }
}

const CHUNK: usize = 8 * 1024 * 1024;
const MIN_ROOM: usize = 64 * 1024;

/// Lit au plus `max_bytes` octets (+1 pour détecter le dépassement), par
/// blocs, en vérifiant l'annulation entre chaque bloc.
///
/// La taille de chaque bloc suit la capacité réservée d'après `size_hint`
/// (bornée à CHUNK) : un petit fichier ne coûte qu'un petit tampon.
/// Régression mesurée par le banc d'essai : avec des blocs fixes de 8 Mo, le
/// tampon était initialisé à 8 Mo deux fois par fichier (≈ 1,5 ms par
/// fichier de 8 Ko lors d'une recherche dans un dossier).
pub fn read_limited(path: &Path, max_bytes: u64, size_hint: u64, cancel: Option<&AtomicBool>) -> ApiResult<Vec<u8>> {
    let mut f = File::open(path).map_err(|e| io_error(&e, path))?;
    let cap = size_hint.min(max_bytes).saturating_add(1) as usize;
    let mut buf: Vec<u8> = Vec::with_capacity(cap.min(1 << 31));
    let limit = max_bytes.saturating_add(1);
    loop {
        if let Some(c) = cancel {
            if c.load(Ordering::Relaxed) {
                return Err(ApiError::cancelled());
            }
        }
        // Capacité restante (l'octet de détection du dépassement compris) ;
        // fichier plus grand que prévu : croissance géométrique.
        let spare = match buf.capacity() - buf.len() {
            0 => buf.len().max(MIN_ROOM),
            n => n,
        };
        let room = (limit - buf.len() as u64).min(CHUNK as u64).min(spare as u64) as usize;
        if room == 0 {
            break;
        }
        let start = buf.len();
        buf.resize(start + room, 0);
        let n = match f.read(&mut buf[start..]) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => 0,
            Err(e) => return Err(io_error(&e, path)),
        };
        buf.truncate(start + n);
        if n == 0 {
            break;
        }
    }
    Ok(buf)
}

fn too_large(size: u64, limit: u64) -> ApiError {
    ApiError::new(
        "too_large",
        format!(
            "Ce fichier ({}) dépasse la taille maximale d'ouverture en édition ({}).",
            human_size(size),
            human_size(limit)
        ),
    )
    .with_detail(Obj::new().put("size", size).put("limit", limit).build())
}

pub fn human_size(n: u64) -> String {
    const U: [&str; 5] = ["octets", "Ko", "Mo", "Go", "To"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} octets")
    } else {
        format!("{:.1} {}", v, U[i]).replace('.', ",")
    }
}

pub fn open_text(req: &OpenRequest) -> ApiResult<OpenedText> {
    let path = req.path;
    let meta = fs::metadata(path).map_err(|e| io_error(&e, path))?;
    if meta.is_dir() {
        return Err(ApiError::new("is_directory", format!("« {} » est un dossier.", paths::display(path))));
    }
    if meta.len() > req.max_bytes {
        return Err(too_large(meta.len(), req.max_bytes));
    }
    let before = Stamp::of(&meta);
    let mut bytes = read_limited(path, req.max_bytes, meta.len(), req.cancel)?;
    if bytes.len() as u64 > req.max_bytes {
        return Err(too_large(bytes.len() as u64, req.max_bytes));
    }
    // Le fichier a-t-il changé pendant la lecture ? Une seconde tentative.
    let mut unstable = false;
    let after = fs::metadata(path).map(|m| Stamp::of(&m)).unwrap_or(before);
    let mut stamp = before;
    if after != before {
        bytes = read_limited(path, req.max_bytes, after.size, req.cancel)?;
        if bytes.len() as u64 > req.max_bytes {
            return Err(too_large(bytes.len() as u64, req.max_bytes));
        }
        let again = fs::metadata(path).map(|m| Stamp::of(&m)).unwrap_or(after);
        unstable = again != after;
        // Seconde lecture stable : le contenu correspond à `after`. Sinon on
        // garde l'empreinte la plus ancienne, si bien qu'un enregistrement
        // ultérieur signalera un conflit au lieu d'écraser des données non vues.
        if !unstable {
            stamp = after;
        }
    }

    let detection = match req.forced {
        Some(cs) => {
            let bom = match cs {
                Charset::Utf8 => bytes.starts_with(&[0xEF, 0xBB, 0xBF]),
                Charset::Utf16Le => bytes.starts_with(&[0xFF, 0xFE]),
                Charset::Utf16Be => bytes.starts_with(&[0xFE, 0xFF]),
                Charset::Windows1252 => false,
            };
            let bom = bom || (matches!(cs, Charset::Utf16Le | Charset::Utf16Be) && bytes.is_empty());
            encoding::Detection { encoding: Encoding { charset: cs, bom }, confidence: Confidence::Forced }
        }
        None => encoding::detect(&bytes),
    };
    let binary = encoding::sniff_binary(&bytes, detection.encoding);
    if let Some(reason) = binary {
        if !req.allow_binary {
            return Err(ApiError::new(
                "binary",
                format!("« {} » ne semble pas être un fichier texte ({reason}).", paths::file_name_lossy(path)),
            )
            .with_detail(Obj::new().put("reason", reason).put("size", meta.len()).build()));
        }
    }
    let decoded = encoding::decode(bytes, detection.encoding.charset);
    let mut enc = detection.encoding;
    if detection.confidence == Confidence::Forced {
        enc.bom = decoded.had_bom;
    }
    let eol_stats = EolStats::scan(decoded.text.as_bytes());
    let eol = eol_stats.dominant(req.default_eol);
    let link_target = fs::symlink_metadata(path)
        .ok()
        .filter(|m| m.file_type().is_symlink())
        .and_then(|_| paths::canonical_display(path));
    Ok(OpenedText {
        path: paths::display(path),
        name: paths::file_name_lossy(path),
        text: decoded.text,
        encoding: enc,
        confidence: detection.confidence,
        replaced: decoded.replaced,
        eol,
        eol_stats,
        stamp,
        readonly: meta.permissions().readonly(),
        size: meta.len(),
        link_target,
        unstable,
        binary_reason: binary,
    })
}

pub struct SaveRequest<'a> {
    pub path: &'a Path,
    pub text: &'a str,
    pub encoding: Encoding,
    pub eol: Eol,
    /// Empreinte connue du fichier ; `None` pour un nouveau fichier ou
    /// « Enregistrer sous » (la boîte de dialogue a déjà confirmé).
    pub expected: Option<&'a str>,
    /// Ignorer un conflit ou une suppression externe (après confirmation).
    pub force: bool,
    /// Échouer si le fichier existe déjà.
    pub create_new: bool,
}

#[derive(Debug, Clone)]
pub struct SaveResult {
    pub path: String,
    pub stamp: Stamp,
    pub bytes_written: u64,
    /// `false` si l'écriture a dû se faire sur place (dossier non modifiable).
    pub atomic: bool,
}

impl SaveResult {
    pub fn to_json(&self) -> Json {
        Obj::new()
            .put("path", self.path.clone())
            .put("stamp", self.stamp.token())
            .put("mtimeMs", self.stamp.mtime_ms())
            .put("size", self.stamp.size)
            .put("bytesWritten", self.bytes_written)
            .put("atomic", self.atomic)
            .build()
    }
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_sibling(target: &Path, tag: &str) -> PathBuf {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = paths::file_name_lossy(target);
    let short: String = name.chars().take(80).collect();
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    dir.join(format!(".{short}.swiftpad-{tag}-{}-{nanos:x}-{n}.tmp", std::process::id()))
}

pub fn save_text(req: &SaveRequest) -> ApiResult<SaveResult> {
    let bytes = encoding::encode(req.text, req.encoding, req.eol).map_err(|u| {
        ApiError::new(
            "unencodable",
            format!(
                "Le caractère « {} » (U+{:04X}, ligne {}, colonne {}) ne peut pas être enregistré en {}{}.",
                u.ch,
                u.ch as u32,
                u.line,
                u.column,
                req.encoding.label(),
                if u.count > 1 { format!(" ; {} caractère(s) concerné(s) au total", u.count) } else { String::new() }
            ),
        )
        .with_detail(
            Obj::new()
                .put("char", u.ch.to_string())
                .put("codepoint", u.ch as u32)
                .put("line", u.line)
                .put("column", u.column)
                .put("count", u.count)
                .build(),
        )
    })?;
    write_bytes_checked(req.path, &bytes, req.expected, req.force, req.create_new)
}

/// Écrit `bytes` avec contrôle de conflit, attribut lecture seule et
/// remplacement atomique. Utilisé pour les documents et les fichiers internes.
pub fn write_bytes_checked(path: &Path, bytes: &[u8], expected: Option<&str>, force: bool, create_new: bool) -> ApiResult<SaveResult> {
    // Un lien symbolique est conservé : on remplace sa cible.
    let target: PathBuf = match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(path).map_err(|e| io_error(&e, path))?,
        _ => path.to_path_buf(),
    };
    let existing = match fs::metadata(&target) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(io_error(&e, &target)),
    };
    if let Some(m) = &existing {
        if m.is_dir() {
            return Err(ApiError::new("is_directory", format!("« {} » est un dossier.", paths::display(&target))));
        }
        if create_new {
            return Err(ApiError::new("already_exists", format!("« {} » existe déjà.", paths::display(&target))));
        }
    }
    if let Some(exp) = expected {
        match &existing {
            None if !force => {
                return Err(ApiError::new(
                    "deleted",
                    format!("« {} » a été supprimé ou déplacé depuis son ouverture.", paths::display(&target)),
                ))
            }
            Some(m) if !force && Stamp::of(m).token() != exp => {
                let st = Stamp::of(m);
                return Err(ApiError::new(
                    "conflict",
                    format!("« {} » a été modifié par un autre programme depuis son ouverture.", paths::file_name_lossy(&target)),
                )
                .with_detail(Obj::new().put("stamp", st.token()).put("mtimeMs", st.mtime_ms()).put("size", st.size).build()));
            }
            _ => {}
        }
    }
    if let Some(m) = &existing {
        if m.permissions().readonly() {
            return Err(ApiError::new(
                "readonly",
                format!("« {} » est en lecture seule. Utilisez « Enregistrer sous… ».", paths::file_name_lossy(&target)),
            ));
        }
    }
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    if existing.is_none() && !parent.is_dir() {
        return Err(ApiError::new("not_found", format!("Le dossier « {} » n'existe pas.", paths::display(parent))));
    }

    let tmp = temp_sibling(&target, "save");
    let tmp_file = OpenOptions::new().write(true).create_new(true).open(&tmp);
    let mut atomic = true;
    match tmp_file {
        Ok(mut f) => {
            let res = f.write_all(bytes).and_then(|_| f.sync_all());
            drop(f);
            if let Err(e) = res {
                let _ = fs::remove_file(&tmp);
                return Err(io_error(&e, &target));
            }
            if let Some(m) = &existing {
                #[cfg(unix)]
                {
                    let _ = fs::set_permissions(&tmp, m.permissions());
                }
                #[cfg(not(unix))]
                let _ = m;
                let backup = temp_sibling(&target, "bak");
                if let Err(e) = crate::platform::replace_file(&target, &tmp, &backup) {
                    if crate::platform::replace_unsupported(&e) {
                        if let Err(e2) = fs::rename(&tmp, &target) {
                            let _ = fs::remove_file(&tmp);
                            return Err(io_error(&e2, &target));
                        }
                    } else {
                        let _ = fs::remove_file(&tmp);
                        return Err(io_error(&e, &target));
                    }
                }
            } else if let Err(e) = fs::rename(&tmp, &target) {
                let _ = fs::remove_file(&tmp);
                return Err(io_error(&e, &target));
            }
            sync_dir(parent);
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && existing.is_some() => {
            // Dossier non modifiable mais fichier modifiable : écriture sur place.
            atomic = false;
            let mut f = OpenOptions::new().write(true).truncate(true).open(&target).map_err(|e| io_error(&e, &target))?;
            f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| io_error(&e, &target))?;
        }
        Err(e) => return Err(io_error(&e, &target)),
    }
    let meta = fs::metadata(&target).map_err(|e| io_error(&e, &target))?;
    Ok(SaveResult { path: paths::display(&target), stamp: Stamp::of(&meta), bytes_written: bytes.len() as u64, atomic })
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(f) = File::open(dir) {
        let _ = f.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

/// Écriture atomique simple pour les fichiers internes (paramètres, session).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> ApiResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_error(&e, parent))?;
    }
    write_bytes_checked(path, bytes, None, true, false).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn open(p: &Path) -> ApiResult<OpenedText> {
        open_text(&OpenRequest { path: p, max_bytes: 1 << 30, allow_binary: false, forced: None, default_eol: Eol::CrLf, cancel: None })
    }

    #[test]
    fn open_edit_save_roundtrip() {
        let d = TempDir::new("tf");
        let p = d.join("notes été.txt");
        fs::write(&p, "ligne 1\r\nligne 2\r\n").unwrap();
        let doc = open(&p).unwrap();
        assert_eq!(doc.text, "ligne 1\r\nligne 2\r\n");
        assert_eq!(doc.eol, Eol::CrLf);
        assert_eq!(doc.encoding, Encoding::UTF8);
        assert_eq!(doc.confidence, Confidence::Ascii);
        let edited = "ligne 1\nligne 2 modifiée\n";
        let r = save_text(&SaveRequest {
            path: &p,
            text: edited,
            encoding: doc.encoding,
            eol: doc.eol,
            expected: Some(&doc.stamp.token()),
            force: false,
            create_new: false,
        })
        .unwrap();
        assert!(r.atomic);
        assert_eq!(fs::read(&p).unwrap(), "ligne 1\r\nligne 2 modifiée\r\n".as_bytes());
        // Aucun fichier temporaire ne subsiste.
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }

    /// Lecture exacte quelle que soit l'estimation de taille (fichier modifié
    /// entre le `stat` et la lecture), y compris au-delà d'un bloc de 8 Mo,
    /// et détection du dépassement par l'octet supplémentaire.
    #[test]
    fn read_limited_is_exact_whatever_the_size_hint() {
        let d = TempDir::new("tf");
        for &size in &[0usize, 1, 4095, 65_536, 200_000, CHUNK + 3] {
            let p = d.join(format!("f{size}"));
            let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            fs::write(&p, &data).unwrap();
            for &hint in &[0u64, 1, size as u64 / 2, size as u64, size as u64 * 3 + 10] {
                assert_eq!(read_limited(&p, 1 << 30, hint, None).unwrap(), data, "taille {size}, estimation {hint}");
            }
            if size > 10 {
                // Limite atteinte : max_bytes + 1 octets lus (signal « trop grand »).
                let r = read_limited(&p, 10, size as u64, None).unwrap();
                assert_eq!(r, data[..11].to_vec());
            }
        }
        let flag = AtomicBool::new(true);
        assert_eq!(read_limited(&d.join("f1"), 100, 1, Some(&flag)).unwrap_err().code, "cancelled");
    }

    #[test]
    fn empty_file() {
        let d = TempDir::new("tf");
        let p = d.join("vide.txt");
        fs::write(&p, "").unwrap();
        let doc = open(&p).unwrap();
        assert_eq!(doc.text, "");
        assert_eq!(doc.eol, Eol::CrLf); // défaut fourni
        save_text(&SaveRequest { path: &p, text: "", encoding: Encoding::UTF8, eol: Eol::CrLf, expected: Some(&doc.stamp.token()), force: false, create_new: false }).unwrap();
        assert_eq!(fs::read(&p).unwrap().len(), 0);
    }

    #[test]
    fn conflict_and_deleted_detection() {
        let d = TempDir::new("tf");
        let p = d.join("c.txt");
        fs::write(&p, "a").unwrap();
        let doc = open(&p).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&p, "modifié ailleurs").unwrap();
        let req = |force| SaveRequest { path: &p, text: "mien", encoding: Encoding::UTF8, eol: Eol::Lf, expected: Some(Box::leak(doc.stamp.token().into_boxed_str())), force, create_new: false };
        let e = save_text(&req(false)).unwrap_err();
        assert_eq!(e.code, "conflict");
        assert_eq!(fs::read_to_string(&p).unwrap(), "modifié ailleurs");
        save_text(&req(true)).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "mien");
        fs::remove_file(&p).unwrap();
        let e = save_text(&req(false)).unwrap_err();
        assert_eq!(e.code, "deleted");
        save_text(&req(true)).unwrap();
        assert!(p.exists());
    }

    #[test]
    fn readonly_is_respected() {
        let d = TempDir::new("tf");
        let p = d.join("ro.txt");
        fs::write(&p, "x").unwrap();
        let mut perm = fs::metadata(&p).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&p, perm).unwrap();
        let doc = open(&p).unwrap();
        assert!(doc.readonly);
        let e = save_text(&SaveRequest { path: &p, text: "y", encoding: Encoding::UTF8, eol: Eol::Lf, expected: Some(&doc.stamp.token()), force: true, create_new: false }).unwrap_err();
        assert_eq!(e.code, "readonly");
        assert_eq!(fs::read_to_string(&p).unwrap(), "x");
    }

    #[test]
    fn binary_needs_confirmation() {
        let d = TempDir::new("tf");
        let p = d.join("img.png");
        fs::write(&p, b"\x89PNG\r\n\x1a\n\x00\x00").unwrap();
        let e = open(&p).unwrap_err();
        assert_eq!(e.code, "binary");
        let doc = open_text(&OpenRequest { path: &p, max_bytes: 1 << 20, allow_binary: true, forced: None, default_eol: Eol::Lf, cancel: None }).unwrap();
        assert_eq!(doc.binary_reason, Some("image PNG"));
    }

    #[test]
    fn too_large_and_cancel() {
        let d = TempDir::new("tf");
        let p = d.join("big.txt");
        fs::write(&p, vec![b'a'; 2000]).unwrap();
        let e = open_text(&OpenRequest { path: &p, max_bytes: 1000, allow_binary: false, forced: None, default_eol: Eol::Lf, cancel: None }).unwrap_err();
        assert_eq!(e.code, "too_large");
        let flag = AtomicBool::new(true);
        let e = open_text(&OpenRequest { path: &p, max_bytes: 1 << 20, allow_binary: false, forced: None, default_eol: Eol::Lf, cancel: Some(&flag) }).unwrap_err();
        assert_eq!(e.code, "cancelled");
    }

    #[test]
    fn forced_encoding_and_mixed_eol() {
        let d = TempDir::new("tf");
        let p = d.join("m.txt");
        fs::write(&p, b"caf\xE9\r\nb\nc").unwrap();
        let doc = open(&p).unwrap();
        assert_eq!(doc.encoding, Encoding::WINDOWS1252);
        assert!(doc.confidence.is_uncertain());
        assert!(doc.eol_stats.is_mixed());
        assert_eq!(doc.text, "café\r\nb\nc");
        let doc2 = open_text(&OpenRequest { path: &p, max_bytes: 1 << 20, allow_binary: false, forced: Some(Charset::Utf8), default_eol: Eol::Lf, cancel: None }).unwrap();
        assert_eq!(doc2.replaced, 1);
        assert_eq!(doc2.confidence, Confidence::Forced);
    }

    #[test]
    fn unencodable_blocks_save() {
        let d = TempDir::new("tf");
        let p = d.join("u.txt");
        fs::write(&p, b"abc").unwrap();
        let e = save_text(&SaveRequest { path: &p, text: "a ✓", encoding: Encoding::WINDOWS1252, eol: Eol::Lf, expected: None, force: false, create_new: false }).unwrap_err();
        assert_eq!(e.code, "unencodable");
        assert_eq!(fs::read(&p).unwrap(), b"abc");
    }

    #[test]
    fn create_new_and_missing_dir() {
        let d = TempDir::new("tf");
        let p = d.join("n.txt");
        save_text(&SaveRequest { path: &p, text: "x", encoding: Encoding::UTF8, eol: Eol::Lf, expected: None, force: false, create_new: true }).unwrap();
        let e = save_text(&SaveRequest { path: &p, text: "x", encoding: Encoding::UTF8, eol: Eol::Lf, expected: None, force: false, create_new: true }).unwrap_err();
        assert_eq!(e.code, "already_exists");
        let q = d.join("absent/n.txt");
        let e = save_text(&SaveRequest { path: &q, text: "x", encoding: Encoding::UTF8, eol: Eol::Lf, expected: None, force: false, create_new: false }).unwrap_err();
        assert_eq!(e.code, "not_found");
        let e = open(d.path()).unwrap_err();
        assert_eq!(e.code, "is_directory");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_is_replaced_and_link_kept() {
        let d = TempDir::new("tf");
        let real = d.join("réel.txt");
        let link = d.join("lien.txt");
        fs::write(&real, "v1").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let doc = open(&link).unwrap();
        assert!(doc.link_target.is_some());
        save_text(&SaveRequest { path: &link, text: "v2", encoding: Encoding::UTF8, eol: Eol::Lf, expected: Some(&doc.stamp.token()), force: false, create_new: false }).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "v2");
    }

    #[cfg(unix)]
    #[test]
    fn permissions_are_preserved() {
        use std::os::unix::fs::PermissionsExt;
        let d = TempDir::new("tf");
        let p = d.join("x.sh");
        fs::write(&p, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o751)).unwrap();
        let doc = open(&p).unwrap();
        save_text(&SaveRequest { path: &p, text: "#!/bin/sh\necho\n", encoding: Encoding::UTF8, eol: Eol::Lf, expected: Some(&doc.stamp.token()), force: false, create_new: false }).unwrap();
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o751);
    }

    #[test]
    fn sizes_are_human() {
        assert_eq!(human_size(500), "500 octets");
        assert_eq!(human_size(1536), "1,5 Ko");
        assert_eq!(human_size(5 * 1024 * 1024), "5,0 Mo");
    }
}
