//! Point d'entrée unique des requêtes de l'interface.
//!
//! Format binaire (identique dans Tauri et dans le harnais de test) :
//! * requête : `u32 LE` longueur du JSON `{cmd, args}`, le JSON, puis une
//!   charge utile brute facultative (texte d'un document à enregistrer) ;
//! * réponse : un octet de type — 0 = JSON, 1 = binaire (`u32 LE` longueur
//!   de l'en-tête JSON, l'en-tête, les octets), 2 = erreur JSON.
//!
//! La liste des commandes est fermée et réduite à ce que l'interface
//! utilise : ouvrir, enregistrer, renommer un document, lire un aperçu,
//! paramètres, session, copies de récupération, gros fichiers. Rien ne
//! permet d'exécuter un programme, d'évaluer du contenu, de parcourir un
//! dossier ni de copier, déplacer ou supprimer un fichier.

use crate::bigfile::BigFiles;
use crate::encoding::{Charset, Encoding};
use crate::eol::Eol;
use crate::error::{ApiError, ApiResult};
use crate::fsops;
use crate::jobs::{CancelTokens, Jobs};
use crate::json::{Json, Obj};
use crate::search::Matcher;
use crate::{paths, settings, store, textfile};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct Request {
    pub cmd: String,
    pub args: Json,
    pub payload: Vec<u8>,
}

impl Request {
    pub fn parse(bytes: &[u8]) -> ApiResult<Request> {
        if bytes.len() < 4 {
            return Err(ApiError::invalid_args("Requête tronquée."));
        }
        let n = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        if 4 + n > bytes.len() {
            return Err(ApiError::invalid_args("Requête tronquée."));
        }
        let head = Json::parse_bytes(&bytes[4..4 + n]).map_err(|e| ApiError::invalid_args(e.to_string()))?;
        let cmd = head.str_of("cmd").ok_or_else(|| ApiError::invalid_args("Commande absente."))?.to_string();
        let args = head.get("args").cloned().unwrap_or_else(Json::obj);
        Ok(Request { cmd, args, payload: bytes[4 + n..].to_vec() })
    }

    pub fn encode(cmd: &str, args: &Json, payload: &[u8]) -> Vec<u8> {
        let head = Obj::new().put("cmd", cmd).put("args", args.clone()).build().to_string();
        let mut out = Vec::with_capacity(4 + head.len() + payload.len());
        out.extend_from_slice(&(head.len() as u32).to_le_bytes());
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(payload);
        out
    }
}

pub enum Reply {
    Json(Json),
    Bytes { header: Json, body: Vec<u8> },
}

pub fn encode_reply(r: ApiResult<Reply>) -> Vec<u8> {
    match r {
        Ok(Reply::Json(j)) => {
            let s = j.to_string();
            let mut out = Vec::with_capacity(1 + s.len());
            out.push(0);
            out.extend_from_slice(s.as_bytes());
            out
        }
        Ok(Reply::Bytes { header, body }) => {
            let h = header.to_string();
            let mut out = Vec::with_capacity(5 + h.len() + body.len());
            out.push(1);
            out.extend_from_slice(&(h.len() as u32).to_le_bytes());
            out.extend_from_slice(h.as_bytes());
            out.extend_from_slice(&body);
            out
        }
        Err(e) => {
            let s = e.to_json().to_string();
            let mut out = Vec::with_capacity(1 + s.len());
            out.push(2);
            out.extend_from_slice(s.as_bytes());
            out
        }
    }
}

/// Décodage d'une réponse (tests, harnais).
pub fn decode_reply(bytes: &[u8]) -> Result<(Json, Vec<u8>), Json> {
    match bytes.first() {
        Some(0) => Ok((Json::parse_bytes(&bytes[1..]).unwrap_or(Json::Null), Vec::new())),
        Some(1) => {
            let n = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
            let h = Json::parse_bytes(&bytes[5..5 + n]).unwrap_or(Json::Null);
            Ok((h, bytes[5 + n..].to_vec()))
        }
        _ => Err(Json::parse_bytes(bytes.get(1..).unwrap_or(&[])).unwrap_or(Json::Null)),
    }
}

#[derive(Clone, Debug)]
pub struct Place {
    pub label: String,
    pub path: PathBuf,
}

pub struct Config {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub home_dir: Option<PathBuf>,
    pub places: Vec<Place>,
    pub version: String,
    pub launch_files: Vec<String>,
    /// Dossier courant au lancement (chemins relatifs en argument).
    pub cwd: Option<PathBuf>,
}

pub struct Core {
    pub cfg: Config,
    pub jobs: Jobs,
    pub cancels: CancelTokens,
    pub big: BigFiles,
    pending_open: Mutex<Vec<String>>,
    perf_marks: Mutex<Vec<(String, f64)>>,
}

pub fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn arg_str<'a>(args: &'a Json, key: &str) -> ApiResult<&'a str> {
    args.str_of(key).ok_or_else(|| ApiError::invalid_args(format!("Argument « {key} » manquant.")))
}

/// Chemin absolu fourni par l'interface (jamais relatif, jamais un périphérique).
fn arg_path(args: &Json, key: &str) -> ApiResult<PathBuf> {
    let s = arg_str(args, key)?;
    check_path(s)
}

fn check_path(s: &str) -> ApiResult<PathBuf> {
    if s.is_empty() || s.contains('\0') {
        return Err(ApiError::new("invalid_path", "Chemin invalide."));
    }
    paths::check_device_path_str(s)?;
    let p = PathBuf::from(s);
    if !p.is_absolute() {
        return Err(ApiError::new("invalid_path", format!("Chemin non absolu : « {s} ».")));
    }
    Ok(p)
}

fn arg_paths(args: &Json, key: &str) -> ApiResult<Vec<PathBuf>> {
    let list = args.strings_of(key).ok_or_else(|| ApiError::invalid_args(format!("Argument « {key} » manquant.")))?;
    list.iter().map(|s| check_path(s)).collect()
}

fn mime_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

impl Core {
    pub fn new(cfg: Config) -> Arc<Core> {
        Arc::new(Core {
            cfg,
            jobs: Jobs::new(),
            cancels: CancelTokens::default(),
            big: BigFiles::default(),
            pending_open: Mutex::new(Vec::new()),
            perf_marks: Mutex::new(Vec::new()),
        })
    }

    pub fn settings_path(&self) -> PathBuf {
        self.cfg.config_dir.join("settings.json")
    }

    pub fn session_path(&self) -> PathBuf {
        self.cfg.config_dir.join("session.json")
    }

    pub fn recovery_dir(&self) -> PathBuf {
        self.cfg.data_dir.join("recovery")
    }

    /// Paramètres validés (lecture directe, utilisée avant la création de la fenêtre).
    pub fn load_settings(&self) -> settings::Loaded {
        settings::load(&self.settings_path())
    }

    /// Chemins à ouvrir reçus d'une seconde instance ou d'un glisser-déposer.
    pub fn queue_open(&self, files: Vec<String>) {
        self.pending_open.lock().unwrap_or_else(|e| e.into_inner()).extend(files);
    }

    pub fn mark(&self, name: &str) {
        self.perf_marks.lock().unwrap_or_else(|e| e.into_inner()).push((name.to_string(), crate::time::now_ms()));
    }

    /// Normalise les arguments de lancement (chemins relatifs, guillemets).
    pub fn normalize_launch_args<I: IntoIterator<Item = String>>(&self, args: I) -> Vec<String> {
        self.normalize_launch_args_in(args, self.cfg.cwd.as_deref())
    }

    /// Variante avec un dossier courant explicite (seconde instance lancée
    /// depuis un autre dossier).
    pub fn normalize_launch_args_in<I: IntoIterator<Item = String>>(&self, args: I, cwd: Option<&Path>) -> Vec<String> {
        args.into_iter()
            .filter(|a| !a.starts_with("--") && !a.is_empty())
            .filter_map(|a| paths::resolve_user_path(&a, self.cfg.home_dir.as_deref(), cwd).ok())
            .map(|p| paths::display(&p))
            .collect()
    }

    /// Données de démarrage injectées dans la page avant tout script : la
    /// première image est dessinée sans aucun aller-retour.
    pub fn boot(&self) -> Json {
        let loaded = self.load_settings();
        let s = &loaded.settings;
        let get_bool = |a: &str, b: &str| s.get(a).and_then(|o| o.bool_of(b)).unwrap_or(false);
        let restore = get_bool("session", "restore");
        let recovery_on = get_bool("session", "recovery");
        let session = if restore { store::session_load(&self.session_path()) } else { Json::Null };
        let recovery = if recovery_on {
            store::recovery_list(&self.recovery_dir())
        } else {
            // Option désactivée : aucune copie ne doit subsister.
            let _ = store::recovery_purge(&self.recovery_dir());
            Json::Arr(vec![])
        };
        let pinfo = crate::platform::process_info();
        Obj::new()
            .put("version", self.cfg.version.clone())
            .put("platform", platform_name())
            .put("pathSep", std::path::MAIN_SEPARATOR.to_string())
            .put("settings", loaded.settings.clone())
            .put("settingsNotice", loaded.notice.clone())
            .put("session", session)
            .put("recovery", recovery)
            .put("launchFiles", self.cfg.launch_files.clone())
            .put("home", self.cfg.home_dir.as_deref().map(paths::display))
            .put(
                "places",
                Json::Arr(self.cfg.places.iter().map(|p| Obj::new().put("label", p.label.clone()).put("path", paths::display(&p.path)).build()).collect()),
            )
            .put("dataInfo", store::describe(&self.cfg.config_dir, &self.cfg.data_dir))
            .put("processStartMs", pinfo.started_at_ms)
            .put("bootMs", crate::time::now_ms())
            .put("perfLog", perf_log_path().is_some())
            .build()
    }

    /// Traite une requête binaire et renvoie la réponse binaire.
    pub fn handle(&self, bytes: &[u8]) -> Vec<u8> {
        let reply = Request::parse(bytes).and_then(|req| self.dispatch(&req));
        encode_reply(reply)
    }

    pub fn dispatch(&self, req: &Request) -> ApiResult<Reply> {
        let a = &req.args;
        let ok = |j: Json| Ok(Reply::Json(j));
        match req.cmd.as_str() {
            "app.boot" => ok(self.boot()),
            "app.pendingOpen" => {
                let files: Vec<String> = std::mem::take(&mut *self.pending_open.lock().unwrap_or_else(|e| e.into_inner()));
                ok(Json::from(files))
            }
            "perf.mark" => {
                self.mark(arg_str(a, "name")?);
                ok(Json::Null)
            }
            "perf.report" => {
                let p = crate::platform::process_info();
                let marks = self.perf_marks.lock().unwrap_or_else(|e| e.into_inner()).clone();
                ok(Obj::new()
                    .put("processStartMs", p.started_at_ms)
                    .put("residentBytes", p.resident_bytes)
                    .put("peakResidentBytes", p.peak_resident_bytes)
                    .put("nowMs", crate::time::now_ms())
                    .put("marks", Json::Arr(marks.into_iter().map(|(n, t)| Obj::new().put("name", n).put("t", t).build()).collect()))
                    .build())
            }
            "perf.write" => {
                // Mesures de démarrage pour les bancs d'essai (scripts/bench-windows.ps1) :
                // une ligne JSON ajoutée au fichier désigné par SWIFTPAD_PERF_LOG,
                // jamais ailleurs, et rien si la variable est absente.
                let Some(path) = perf_log_path() else { return ok(Json::Bool(false)) };
                let p = crate::platform::process_info();
                let marks = self.perf_marks.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let line = Obj::new()
                    .put("processStartMs", p.started_at_ms)
                    .put("nativeResidentBytes", p.resident_bytes)
                    .put("nativePeakResidentBytes", p.peak_resident_bytes)
                    .put("nowMs", crate::time::now_ms())
                    .put("marks", Json::Arr(marks.into_iter().map(|(n, t)| Obj::new().put("name", n).put("t", t).build()).collect()))
                    .put("ui", a.get("ui").cloned().unwrap_or(Json::Null))
                    .build();
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| crate::error::io_error(&e, &path))?;
                writeln!(f, "{line}").map_err(|e| crate::error::io_error(&e, &path))?;
                ok(Json::Bool(true))
            }
            "settings.save" => {
                let incoming = a.get("settings").ok_or_else(|| ApiError::invalid_args("Paramètres manquants."))?;
                let saved = settings::save(&self.settings_path(), incoming)?;
                ok(saved)
            }
            "settings.defaults" => ok(settings::defaults()),
            "session.save" => {
                store::session_save(&self.session_path(), a.get("session").unwrap_or(&Json::Null))?;
                ok(Json::Null)
            }
            "session.clear" => {
                store::session_clear(&self.session_path())?;
                ok(Json::Null)
            }
            "recovery.write" => {
                store::recovery_write(&self.recovery_dir(), arg_str(a, "id")?, a.get("meta").unwrap_or(&Json::Null), &req.payload)?;
                ok(Json::Null)
            }
            "recovery.read" => {
                let body = store::recovery_read(&self.recovery_dir(), arg_str(a, "id")?)?;
                Ok(Reply::Bytes { header: Json::obj(), body })
            }
            "recovery.delete" => {
                store::recovery_delete(&self.recovery_dir(), arg_str(a, "id")?)?;
                ok(Json::Null)
            }
            "recovery.list" => ok(store::recovery_list(&self.recovery_dir())),
            "recovery.purge" => ok(Json::from(store::recovery_purge(&self.recovery_dir())?)),
            "doc.open" => self.doc_open(a),
            "doc.save" => {
                let path = arg_path(a, "path")?;
                let enc = Encoding::from_id(arg_str(a, "encoding")?).ok_or_else(|| ApiError::invalid_args("Encodage inconnu."))?;
                let eol = Eol::from_id(arg_str(a, "eol")?).ok_or_else(|| ApiError::invalid_args("Fin de ligne inconnue."))?;
                let text = std::str::from_utf8(&req.payload).map_err(|_| ApiError::invalid_args("Texte non UTF-8."))?;
                let r = textfile::save_text(&textfile::SaveRequest {
                    path: &path,
                    text,
                    encoding: enc,
                    eol,
                    expected: a.str_of("expected"),
                    force: a.bool_of("force").unwrap_or(false),
                    create_new: a.bool_of("createNew").unwrap_or(false),
                })?;
                ok(r.to_json())
            }
            "doc.stat" => {
                let list = arg_paths(a, "paths")?;
                ok(Json::Arr(list.iter().map(|p| textfile::stat(p).to_json(&paths::display(p))).collect()))
            }
            "fs.rename" => {
                let p = fsops::rename(&arg_path(a, "path")?, arg_str(a, "name")?)?;
                ok(Obj::new().put("path", paths::display(&p)).build())
            }
            "file.info" => self.file_info(a),
            "file.readBinary" => {
                let p = arg_path(a, "path")?;
                let mime = mime_for(&p).ok_or_else(|| ApiError::new("unsupported", "Type de fichier non pris en charge pour l'aperçu."))?;
                let max = a.u64_of("maxBytes").unwrap_or(50 * 1024 * 1024).min(200 * 1024 * 1024);
                let size = std::fs::metadata(&p).map_err(|e| crate::error::io_error(&e, &p))?.len();
                if size > max {
                    return Err(ApiError::new("too_large", format!("Fichier trop volumineux pour l'aperçu ({}).", textfile::human_size(size))));
                }
                let body = textfile::read_limited(&p, max, size, None)?;
                Ok(Reply::Bytes { header: Obj::new().put("mime", mime).put("size", body.len()).build(), body })
            }
            "job.poll" => {
                let id = a.u64_of("id").ok_or_else(|| ApiError::invalid_args("Identifiant manquant."))?;
                ok(self.jobs.poll(id, a.u64_of("waitMs").unwrap_or(250), a.u64_of("max").unwrap_or(500) as usize)?)
            }
            "job.cancel" => ok(Json::from(self.jobs.cancel(a.u64_of("id").unwrap_or(0)))),
            "cancel" => ok(Json::from(self.cancels.cancel(arg_str(a, "id")?))),
            "big.open" => {
                let p = arg_path(a, "path")?;
                let forced = a.str_of("encoding").and_then(Encoding::from_id).map(|e| e.charset);
                let bf = self.big.open(&p, forced, a.bool_of("allowBinary").unwrap_or(false))?;
                let bf2 = bf.clone();
                let job = self.jobs.start("index", move |ctx| BigFiles::index(&bf2, Some(ctx)));
                ok(Obj::new().put("info", bf.info()).put("jobId", job).build())
            }
            "big.info" => ok(self.big.get(a.u64_of("id").unwrap_or(0))?.info()),
            "big.lines" => {
                let bf = self.big.get(a.u64_of("id").unwrap_or(0))?;
                ok(bf.read_lines(a.u64_of("start").unwrap_or(0), a.u64_of("count").unwrap_or(100))?)
            }
            "big.search" => {
                let bf = self.big.get(a.u64_of("id").unwrap_or(0))?;
                let m = Matcher::new(arg_str(a, "query")?, a.bool_of("caseSensitive").unwrap_or(false), a.bool_of("wholeWord").unwrap_or(false));
                let max = a.u64_of("maxResults").unwrap_or(5000).clamp(1, 1_000_000) as usize;
                let id = self.jobs.start("bigsearch", move |ctx| bf.search(&m, max, ctx));
                ok(Obj::new().put("jobId", id).build())
            }
            "big.close" => {
                self.big.close(a.u64_of("id").unwrap_or(0));
                ok(Json::Null)
            }
            _ => Err(ApiError::new("unknown_command", format!("Commande inconnue : {}", req.cmd))),
        }
    }

    fn doc_open(&self, a: &Json) -> ApiResult<Reply> {
        let path = arg_path(a, "path")?;
        let forced = match a.str_of("encoding") {
            Some(id) => Some(Encoding::from_id(id).ok_or_else(|| ApiError::invalid_args("Encodage inconnu."))?.charset),
            None => None,
        };
        let default_eol = a.str_of("defaultEol").and_then(Eol::from_id).unwrap_or(Eol::CrLf);
        let max_bytes = a.u64_of("maxBytes").unwrap_or(64 * 1024 * 1024);
        let cancel_id = a.str_of("cancelId").map(str::to_string);
        let flag = cancel_id.as_deref().map(|id| self.cancels.register(id));
        let res = textfile::open_text(&textfile::OpenRequest {
            path: &path,
            max_bytes,
            allow_binary: a.bool_of("allowBinary").unwrap_or(false),
            forced,
            default_eol,
            cancel: flag.as_deref(),
        });
        if let Some(id) = &cancel_id {
            self.cancels.release(id);
        }
        let doc = res?;
        let header = doc.header();
        Ok(Reply::Bytes { header, body: doc.text.into_bytes() })
    }

    fn file_info(&self, a: &Json) -> ApiResult<Reply> {
        let p = arg_path(a, "path")?;
        let meta = std::fs::metadata(&p).map_err(|e| crate::error::io_error(&e, &p))?;
        let head = if meta.is_file() { textfile::read_limited(&p, 64 * 1024, 64 * 1024, None).unwrap_or_default() } else { Vec::new() };
        let head = &head[..head.len().min(64 * 1024)];
        let det = crate::encoding::detect(head);
        let binary = crate::encoding::sniff_binary(head, det.encoding);
        Ok(Reply::Json(
            Obj::new()
                .put("path", paths::display(&p))
                .put("name", paths::file_name_lossy(&p))
                .put("size", meta.len())
                .put("isDir", meta.is_dir())
                .put("mtimeMs", meta.modified().map(crate::time::system_time_ms).unwrap_or(0.0))
                .put("readonly", meta.permissions().readonly())
                .put("binaryReason", binary)
                .put("mime", mime_for(&p))
                .put("encoding", det.encoding.id())
                .build(),
        ))
    }
}

/// Fichier de mesures de démarrage (variable d'environnement, bancs d'essai).
fn perf_log_path() -> Option<PathBuf> {
    std::env::var_os("SWIFTPAD_PERF_LOG").filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Utilisé par les tests et le harnais : appel direct par commande.
pub fn call(core: &Core, cmd: &str, args: Json, payload: &[u8]) -> Result<(Json, Vec<u8>), Json> {
    decode_reply(&core.handle(&Request::encode(cmd, &args, payload)))
}

#[allow(dead_code)]
fn _assert_charset_used(_: Charset) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn core(d: &TempDir) -> Arc<Core> {
        Core::new(Config {
            config_dir: d.join("config"),
            data_dir: d.join("data"),
            home_dir: Some(d.path().to_path_buf()),
            places: vec![Place { label: "Documents".into(), path: d.join("Documents") }],
            version: "0.1.0".into(),
            launch_files: vec![],
            cwd: None,
        })
    }

    #[test]
    fn envelope_roundtrip() {
        let bytes = Request::encode("x", &Obj::new().put("a", 1u32).build(), b"payload");
        let r = Request::parse(&bytes).unwrap();
        assert_eq!(r.cmd, "x");
        assert_eq!(r.args.u64_of("a"), Some(1));
        assert_eq!(r.payload, b"payload");
        assert!(Request::parse(&[1, 0]).is_err());
        assert!(Request::parse(&[200, 0, 0, 0, b'{']).is_err());
    }

    #[test]
    fn open_save_through_rpc() {
        let d = TempDir::new("rpc");
        let c = core(&d);
        let p = d.join("doc.txt");
        std::fs::write(&p, "a\r\nb").unwrap();
        let (h, body) = call(&c, "doc.open", Obj::new().put("path", paths::display(&p)).build(), &[]).unwrap();
        assert_eq!(body, b"a\r\nb");
        assert_eq!(h.str_of("eol"), Some("crlf"));
        let stamp = h.str_of("stamp").unwrap().to_string();
        let args = Obj::new().put("path", paths::display(&p)).put("encoding", "utf-8").put("eol", "crlf").put("expected", stamp).build();
        let (r, _) = call(&c, "doc.save", args, "a\nb\nc".as_bytes()).unwrap();
        assert_eq!(r.u64_of("size"), Some(7));
        assert_eq!(std::fs::read(&p).unwrap(), b"a\r\nb\r\nc");
        let err = call(&c, "doc.open", Obj::new().put("path", "relatif.txt").build(), &[]).unwrap_err();
        assert_eq!(err.str_of("code"), Some("invalid_path"));
        let err = call(&c, "nope", Json::obj(), &[]).unwrap_err();
        assert_eq!(err.str_of("code"), Some("unknown_command"));
    }

    /// perf.write n'écrit que si SWIFTPAD_PERF_LOG est définie, et seulement
    /// dans ce fichier (une ligne JSON par appel).
    #[test]
    fn perf_write_only_with_env_var() {
        let d = TempDir::new("rpc");
        let c = core(&d);
        let log = d.join("perf.jsonl");
        std::env::remove_var("SWIFTPAD_PERF_LOG");
        let (r, _) = call(&c, "perf.write", Obj::new().put("ui", Obj::new().put("x", 1u32).build()).build(), &[]).unwrap();
        assert_eq!(r, Json::Bool(false));
        assert!(!log.exists());
        std::env::set_var("SWIFTPAD_PERF_LOG", &log);
        assert_eq!(c.boot().bool_of("perfLog"), Some(true));
        call(&c, "perf.mark", Obj::new().put("name", "ui-ready").build(), &[]).unwrap();
        call(&c, "perf.write", Obj::new().put("ui", Obj::new().put("scriptToReadyMs", 12.5).build()).build(), &[]).unwrap();
        call(&c, "perf.write", Obj::new().put("ui", Json::Null).build(), &[]).unwrap();
        std::env::remove_var("SWIFTPAD_PERF_LOG");
        let text = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let first = Json::parse(lines[0]).unwrap();
        assert_eq!(first.get("ui").and_then(|u| u.f64_of("scriptToReadyMs")), Some(12.5));
        assert_eq!(first.get("marks").and_then(Json::as_array).map(|m| m.len()), Some(1));
    }

    #[test]
    fn boot_respects_recovery_setting() {
        let d = TempDir::new("rpc");
        let c = core(&d);
        store::recovery_write(&c.recovery_dir(), "x", &Json::Null, b"secret").unwrap();
        let b = c.boot();
        assert_eq!(b.get("recovery").unwrap().as_array().unwrap().len(), 1);
        let mut s = settings::defaults();
        s.get_mut("session").unwrap().set("recovery", false);
        call(&c, "settings.save", Obj::new().put("settings", s).build(), &[]).unwrap();
        let b = c.boot();
        assert!(b.get("recovery").unwrap().as_array().unwrap().is_empty());
        assert!(store::recovery_list(&c.recovery_dir()).as_array().unwrap().is_empty(), "copies purgées");
    }

    /// Moindre privilège : les commandes de gestion de fichiers (parcours,
    /// copie, déplacement, suppression, recherche dans un dossier) n'existent
    /// pas, même si une page compromise les demandait.
    #[test]
    fn file_management_commands_do_not_exist() {
        let d = TempDir::new("rpc");
        let c = core(&d);
        let f = d.join("garder.txt");
        std::fs::write(&f, "x").unwrap();
        let p = paths::display(&f);
        let dir = paths::display(d.path());
        let attempts = [
            ("fs.delete", Obj::new().put("paths", vec![p.clone()]).put("permanent", true).build()),
            ("fs.transfer", Obj::new().put("op", "move").put("sources", vec![p.clone()]).put("dest", dir.clone()).build()),
            ("fs.duplicate", Obj::new().put("path", p.clone()).build()),
            ("fs.createFile", Obj::new().put("dir", dir.clone()).put("name", "n.txt").build()),
            ("fs.createDir", Obj::new().put("dir", dir.clone()).put("name", "n").build()),
            ("fs.list", Obj::new().put("path", dir.clone()).build()),
            ("fs.roots", Json::obj()),
            ("search.start", Obj::new().put("root", dir.clone()).put("query", "x").build()),
        ];
        for (cmd, args) in attempts {
            let err = call(&c, cmd, args, &[]).unwrap_err();
            assert_eq!(err.str_of("code"), Some("unknown_command"), "{cmd}");
        }
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "x");
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1, "rien de créé");
        // Le renommage d'un document reste possible.
        let (r, _) = call(&c, "fs.rename", Obj::new().put("path", p).put("name", "nouveau.txt").build(), &[]).unwrap();
        assert_eq!(r.str_of("path"), Some(paths::display(&d.join("nouveau.txt")).as_str()));
    }

    #[test]
    fn launch_args_are_normalized() {
        let d = TempDir::new("rpc");
        let mut c = Core::new(Config {
            config_dir: d.join("c"),
            data_dir: d.join("d"),
            home_dir: None,
            places: vec![],
            version: "x".into(),
            launch_files: vec![],
            cwd: Some(d.path().to_path_buf()),
        });
        let core = Arc::get_mut(&mut c).unwrap();
        let v = core.normalize_launch_args(vec!["--perf".to_string(), "notes.txt".to_string(), "".to_string()]);
        assert_eq!(v, vec![paths::display(&d.join("notes.txt"))]);
    }
}
