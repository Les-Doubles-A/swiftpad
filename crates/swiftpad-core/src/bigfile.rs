//! Lecture rapide des très gros fichiers (mode « gros fichier », lecture
//! seule) : le fichier n'est jamais chargé entièrement en mémoire.
//!
//! Un index clairsemé (position d'une ligne sur 256) est construit en
//! arrière-plan pendant que l'utilisateur lit déjà le début du fichier.
//! Lire N lignes à partir de la ligne L coûte au plus la lecture de 255
//! lignes supplémentaires depuis le point d'index le plus proche.

use crate::encoding::{self, Charset, Confidence, Encoding};
use crate::error::{io_error, ApiError, ApiResult};
use crate::jobs::JobCtx;
use crate::json::{Json, Obj};
use crate::search::Matcher;
use crate::textfile::Stamp;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

pub const STEP: u64 = 256;
/// Au-delà, une ligne est tronquée à l'affichage (fichiers minifiés, dumps).
pub const MAX_LINE_BYTES: usize = 16 * 1024;
const CHUNK: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Index {
    /// Position (octets) du début de la ligne k·STEP.
    checkpoints: Vec<u64>,
    /// Nombre de débuts de ligne connus (= lignes complètes repérées + 1).
    lines: u64,
    bytes_done: u64,
    complete: bool,
}

pub struct BigFile {
    pub id: u64,
    pub path: PathBuf,
    pub encoding: Encoding,
    pub confidence: Confidence,
    pub size: u64,
    pub stamp: Stamp,
    data_start: u64,
    /// Séparateur de lignes : `\n` (LF et CRLF) ou `\r` (CR seul).
    sep_cr: bool,
    unit: u64,
    index: RwLock<Index>,
    pub cancel: AtomicBool,
}

impl BigFile {
    fn is_sep(&self, buf: &[u8], i: usize) -> bool {
        let target = if self.sep_cr { b'\r' } else { b'\n' };
        match self.encoding.charset {
            Charset::Utf16Le => buf[i] == target && buf[i + 1] == 0,
            Charset::Utf16Be => buf[i] == 0 && buf[i + 1] == target,
            _ => buf[i] == target,
        }
    }

    /// Positions (relatives) des séparateurs dans `buf`, à partir de `from`.
    fn next_sep(&self, buf: &[u8], from: usize) -> Option<usize> {
        let target = if self.sep_cr { b'\r' } else { b'\n' };
        match self.encoding.charset {
            Charset::Utf16Le | Charset::Utf16Be => {
                let mut i = from;
                while i + 1 < buf.len() {
                    if self.is_sep(buf, i) {
                        return Some(i);
                    }
                    i += 2;
                }
                None
            }
            _ => crate::bytes::memchr(target, &buf[from..]).map(|p| p + from),
        }
    }

    pub fn info(&self) -> Json {
        let idx = self.index.read().unwrap_or_else(|e| e.into_inner());
        Obj::new()
            .put("id", self.id)
            .put("path", crate::paths::display(&self.path))
            .put("name", crate::paths::file_name_lossy(&self.path))
            .put("size", self.size)
            .put("encoding", self.encoding.id())
            .put("encodingLabel", self.encoding.label())
            .put("confidence", self.confidence.id())
            .put("eol", if self.sep_cr { "cr" } else { "lf-or-crlf" })
            .put("stamp", self.stamp.token())
            .put("lines", idx.lines)
            .put("bytesIndexed", idx.bytes_done)
            .put("complete", idx.complete)
            .build()
    }

    fn decode_line(&self, mut raw: Vec<u8>) -> String {
        // Retire le CR d'une fin de ligne CRLF.
        match self.encoding.charset {
            Charset::Utf16Le if !self.sep_cr && raw.len() >= 2 && raw[raw.len() - 2] == b'\r' && raw[raw.len() - 1] == 0 => {
                raw.truncate(raw.len() - 2);
            }
            Charset::Utf16Be if !self.sep_cr && raw.len() >= 2 && raw[raw.len() - 2] == 0 && raw[raw.len() - 1] == b'\r' => {
                raw.truncate(raw.len() - 2);
            }
            Charset::Utf8 | Charset::Windows1252 if !self.sep_cr && raw.last() == Some(&b'\r') => {
                raw.pop();
            }
            _ => {}
        }
        let text = encoding::decode(raw, self.encoding.charset).text;
        // L'interface affiche les lignes telles quelles : pas de BOM résiduelle.
        text
    }

    /// Lit `count` lignes à partir de `start` (0 = première).
    pub fn read_lines(&self, start: u64, count: u64) -> ApiResult<Json> {
        let count = count.min(2000);
        let (offset, mut skip, known, complete) = {
            let idx = self.index.read().unwrap_or_else(|e| e.into_inner());
            if start >= idx.lines && !idx.complete {
                return Ok(Obj::new().put("start", start).put("lines", Json::Arr(vec![])).put("pending", true).put("known", idx.lines).build());
            }
            let cp = ((start / STEP) as usize).min(idx.checkpoints.len().saturating_sub(1));
            let offset = idx.checkpoints.get(cp).copied().unwrap_or(self.data_start);
            (offset, start - cp as u64 * STEP, idx.lines, idx.complete)
        };
        let mut f = File::open(&self.path).map_err(|e| io_error(&e, &self.path))?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| io_error(&e, &self.path))?;
        let mut lines: Vec<Json> = Vec::new();
        let mut truncated: Vec<Json> = Vec::new();
        let mut cur: Vec<u8> = Vec::new();
        let mut cur_truncated = false;
        let mut buf = vec![0u8; 256 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        let unit = self.unit as usize;
        let mut eof = false;
        while (lines.len() as u64) < count && !eof {
            let n = f.read(&mut buf).map_err(|e| io_error(&e, &self.path))?;
            if n == 0 {
                eof = true;
            }
            let mut data = std::mem::take(&mut carry);
            data.extend_from_slice(&buf[..n]);
            // Garde un éventuel octet impair (UTF-16) pour le tour suivant.
            let usable = if unit == 2 { data.len() & !1 } else { data.len() };
            if usable < data.len() {
                carry = data[usable..].to_vec();
            }
            let data = &data[..usable];
            let mut pos = 0;
            while pos < data.len() && (lines.len() as u64) < count {
                match self.next_sep(data, pos) {
                    Some(s) => {
                        if skip > 0 {
                            skip -= 1;
                        } else {
                            push_limited(&mut cur, &data[pos..s], &mut cur_truncated);
                            let line_no = start + lines.len() as u64;
                            if cur_truncated {
                                truncated.push(Json::from(line_no));
                            }
                            lines.push(Json::Str(self.decode_line(std::mem::take(&mut cur))));
                            cur_truncated = false;
                        }
                        pos = s + unit;
                    }
                    None => {
                        if skip == 0 {
                            push_limited(&mut cur, &data[pos..], &mut cur_truncated);
                        }
                        pos = data.len();
                    }
                }
            }
            if eof && skip == 0 && (lines.len() as u64) < count {
                // Dernière ligne (sans séparateur final, éventuellement vide).
                let line_no = start + lines.len() as u64;
                if cur_truncated {
                    truncated.push(Json::from(line_no));
                }
                lines.push(Json::Str(self.decode_line(std::mem::take(&mut cur))));
            }
        }
        Ok(Obj::new()
            .put("start", start)
            .put("lines", Json::Arr(lines))
            .put("truncated", Json::Arr(truncated))
            .put("known", known)
            .put("complete", complete)
            .build())
    }

    fn index_run(&self, ctx: Option<&JobCtx>) -> ApiResult<()> {
        let mut f = File::open(&self.path).map_err(|e| io_error(&e, &self.path))?;
        f.seek(SeekFrom::Start(self.data_start)).map_err(|e| io_error(&e, &self.path))?;
        let mut buf = vec![0u8; CHUNK];
        let mut base = self.data_start;
        let mut lines: u64 = 1; // la première ligne commence au début des données
        let mut carry: Vec<u8> = Vec::new();
        let mut pending_cp: Vec<u64> = Vec::new();
        {
            let mut idx = self.index.write().unwrap_or_else(|e| e.into_inner());
            idx.checkpoints = vec![self.data_start];
            idx.lines = 1;
        }
        loop {
            if self.cancel.load(Ordering::Relaxed) || ctx.map(|c| c.cancelled()).unwrap_or(false) {
                return Err(ApiError::cancelled());
            }
            let n = f.read(&mut buf).map_err(|e| io_error(&e, &self.path))?;
            if n == 0 {
                break;
            }
            let mut data = std::mem::take(&mut carry);
            let data_base = base - data.len() as u64;
            data.extend_from_slice(&buf[..n]);
            let usable = if self.unit == 2 { data.len() & !1 } else { data.len() };
            let mut pos = 0;
            while let Some(s) = self.next_sep(&data[..usable], pos) {
                let next_start = data_base + (s as u64) + self.unit;
                if lines % STEP == 0 {
                    pending_cp.push(next_start);
                }
                lines += 1;
                pos = s + self.unit as usize;
            }
            carry = data[usable..].to_vec();
            base += n as u64;
            let mut idx = self.index.write().unwrap_or_else(|e| e.into_inner());
            idx.checkpoints.append(&mut pending_cp);
            idx.lines = lines;
            idx.bytes_done = base;
            drop(idx);
            if let Some(c) = ctx {
                c.progress(Obj::new().put("lines", lines).put("bytes", base).put("size", self.size).build());
            }
        }
        let mut idx = self.index.write().unwrap_or_else(|e| e.into_inner());
        idx.checkpoints.append(&mut pending_cp);
        idx.lines = lines;
        idx.bytes_done = self.size;
        idx.complete = true;
        Ok(())
    }

    /// Recherche dans tout le fichier (tâche de fond).
    pub fn search(&self, matcher: &Matcher, max_results: usize, ctx: &JobCtx) -> ApiResult<Json> {
        let mut f = File::open(&self.path).map_err(|e| io_error(&e, &self.path))?;
        f.seek(SeekFrom::Start(self.data_start)).map_err(|e| io_error(&e, &self.path))?;
        let mut buf = vec![0u8; CHUNK];
        let mut carry: Vec<u8> = Vec::new();
        let mut line_no: u64 = 0;
        let mut found = 0usize;
        let mut batch = Vec::new();
        let mut done_bytes = self.data_start;
        loop {
            if ctx.cancelled() {
                ctx.push_many(batch);
                return Err(ApiError::cancelled());
            }
            let n = f.read(&mut buf).map_err(|e| io_error(&e, &self.path))?;
            let eof = n == 0;
            let mut data = std::mem::take(&mut carry);
            data.extend_from_slice(&buf[..n]);
            done_bytes += n as u64;
            let usable = if self.unit == 2 { data.len() & !1 } else { data.len() };
            let mut pos = 0;
            loop {
                let (end, next) = match self.next_sep(&data[..usable], pos) {
                    Some(s) => (s, s + self.unit as usize),
                    None if eof => (usable, usable),
                    None => break,
                };
                let raw = &data[pos..end];
                let line = self.decode_line(raw[..raw.len().min(MAX_LINE_BYTES * 4)].to_vec());
                for (col, len) in matcher.find_all(&line, max_results - found) {
                    let (pv, off) = crate::search::preview(&line, col, len);
                    batch.push(Obj::new().put("line", line_no + 1).put("col", col).put("len", len).put("preview", pv).put("previewOffset", off).build());
                    found += 1;
                }
                line_no += 1;
                pos = next;
                if found >= max_results || (eof && pos >= usable) {
                    break;
                }
            }
            if batch.len() >= 50 {
                ctx.push_many(std::mem::take(&mut batch));
            }
            ctx.progress(Obj::new().put("bytes", done_bytes).put("size", self.size).put("matches", found).build());
            if found >= max_results || eof {
                break;
            }
            carry = data[pos..].to_vec();
        }
        ctx.push_many(batch);
        Ok(Obj::new().put("matches", found).put("truncated", found >= max_results).put("lines", line_no).build())
    }
}

fn push_limited(cur: &mut Vec<u8>, part: &[u8], truncated: &mut bool) {
    let room = MAX_LINE_BYTES.saturating_sub(cur.len());
    if part.len() > room {
        cur.extend_from_slice(&part[..room]);
        *truncated = true;
    } else {
        cur.extend_from_slice(part);
    }
}

#[derive(Default)]
pub struct BigFiles {
    map: Mutex<HashMap<u64, Arc<BigFile>>>,
    next: AtomicU64,
}

impl BigFiles {
    /// Ouvre un fichier en lecture rapide. L'indexation doit ensuite être
    /// lancée (tâche de fond) avec [`BigFiles::index`].
    ///
    /// Un contenu binaire (signature connue, octets nuls…) est refusé avec
    /// l'erreur `binary` sauf si `allow_binary` : l'utilisateur confirme
    /// d'abord, comme pour un petit fichier.
    pub fn open(&self, path: &Path, forced: Option<Charset>, allow_binary: bool) -> ApiResult<Arc<BigFile>> {
        let meta = std::fs::metadata(path).map_err(|e| io_error(&e, path))?;
        if meta.is_dir() {
            return Err(ApiError::new("is_directory", "C'est un dossier."));
        }
        // Échantillon de 1 Mo pour l'encodage et le type de fin de ligne.
        let sample = crate::textfile::read_limited(path, 1024 * 1024, 1024 * 1024, None).map(|mut v| {
            v.truncate(1024 * 1024);
            v
        })?;
        let det = match forced {
            Some(cs) => encoding::Detection { encoding: Encoding { charset: cs, bom: false }, confidence: Confidence::Forced },
            None => encoding::detect(&sample),
        };
        if !allow_binary {
            if let Some(reason) = encoding::sniff_binary(&sample, det.encoding) {
                return Err(ApiError::new(
                    "binary",
                    format!("« {} » ne semble pas être un fichier texte ({reason}).", crate::paths::file_name_lossy(path)),
                )
                .with_detail(Obj::new().put("reason", reason).put("size", meta.len()).build()));
            }
        }
        let mut enc = det.encoding;
        let bom_len = match enc.charset {
            Charset::Utf8 if sample.starts_with(&[0xEF, 0xBB, 0xBF]) => 3,
            Charset::Utf16Le if sample.starts_with(&[0xFF, 0xFE]) => 2,
            Charset::Utf16Be if sample.starts_with(&[0xFE, 0xFF]) => 2,
            _ => 0,
        };
        enc.bom = bom_len > 0;
        let unit = if matches!(enc.charset, Charset::Utf16Le | Charset::Utf16Be) { 2 } else { 1 };
        // CR seul uniquement si l'échantillon contient des CR et aucun LF.
        let (has_cr, has_lf) = match enc.charset {
            Charset::Utf16Le => (sample.chunks_exact(2).any(|c| c == [b'\r', 0]), sample.chunks_exact(2).any(|c| c == [b'\n', 0])),
            Charset::Utf16Be => (sample.chunks_exact(2).any(|c| c == [0, b'\r']), sample.chunks_exact(2).any(|c| c == [0, b'\n'])),
            _ => (sample.contains(&b'\r'), sample.contains(&b'\n')),
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let bf = Arc::new(BigFile {
            id,
            path: path.to_path_buf(),
            encoding: enc,
            confidence: det.confidence,
            size: meta.len(),
            stamp: Stamp::of(&meta),
            data_start: bom_len,
            sep_cr: has_cr && !has_lf,
            unit,
            index: RwLock::new(Index { checkpoints: vec![bom_len], lines: 1, bytes_done: bom_len, complete: meta.len() <= bom_len }),
            cancel: AtomicBool::new(false),
        });
        self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(id, bf.clone());
        Ok(bf)
    }

    pub fn get(&self, id: u64) -> ApiResult<Arc<BigFile>> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .ok_or_else(|| ApiError::new("unknown_viewer", "Fichier non ouvert en lecture rapide."))
    }

    pub fn index(bf: &BigFile, ctx: Option<&JobCtx>) -> ApiResult<Json> {
        bf.index_run(ctx)?;
        Ok(bf.info())
    }

    pub fn close(&self, id: u64) {
        if let Some(bf) = self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            bf.cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    /// Gros fichier binaire : refusé sans confirmation (erreur `binary` avec
    /// la raison), accepté avec `allow_binary` ; seul un échantillon est lu.
    #[test]
    fn binary_content_needs_confirmation() {
        let d = TempDir::new("big");
        let p = d.join("archive.dat");
        let mut data = b"PK\x03\x04".to_vec();
        data.extend((0..3_000_000u32).map(|i| (i % 251) as u8));
        std::fs::write(&p, &data).unwrap();
        let reg = BigFiles::default();
        let e = reg.open(&p, None, false).err().expect("refusé");
        assert_eq!(e.code, "binary");
        assert!(e.detail.as_ref().and_then(|d| d.str_of("reason")).is_some());
        assert!(reg.open(&p, None, true).is_ok());
        // Sans signature : octets nuls au milieu du texte.
        let q = d.join("journal.bin");
        let mut t = b"ligne\n".repeat(400_000);
        t[1000] = 0;
        t[1001] = 0;
        std::fs::write(&q, &t).unwrap();
        assert_eq!(reg.open(&q, None, false).err().map(|e| e.code), Some("binary"));
    }

    fn lines_of(j: &Json) -> Vec<String> {
        j.get("lines").unwrap().as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
    }

    fn make(content: &[u8]) -> (TempDir, Arc<BigFile>, BigFiles) {
        let d = TempDir::new("big");
        let p = d.join("big.log");
        std::fs::write(&p, content).unwrap();
        let reg = BigFiles::default();
        let bf = reg.open(&p, None, false).unwrap();
        BigFiles::index(&bf, None).unwrap();
        (d, bf, reg)
    }

    #[test]
    fn index_and_random_access() {
        let mut s = String::new();
        for i in 0..10_000 {
            s.push_str(&format!("ligne {i} é\r\n"));
        }
        let (_d, bf, _r) = make(s.as_bytes());
        let info = bf.info();
        assert_eq!(info.u64_of("lines"), Some(10_001)); // + ligne vide finale
        assert_eq!(info.bool_of("complete"), Some(true));
        let r = bf.read_lines(0, 3).unwrap();
        assert_eq!(lines_of(&r), vec!["ligne 0 é", "ligne 1 é", "ligne 2 é"]);
        let r = bf.read_lines(5000, 2).unwrap();
        assert_eq!(lines_of(&r), vec!["ligne 5000 é", "ligne 5001 é"]);
        let r = bf.read_lines(9999, 5).unwrap();
        assert_eq!(lines_of(&r), vec!["ligne 9999 é", ""]);
        let r = bf.read_lines(STEP * 3 - 1, 2).unwrap();
        assert_eq!(lines_of(&r), vec![format!("ligne {} é", STEP * 3 - 1), format!("ligne {} é", STEP * 3)]);
    }

    #[test]
    fn utf16_and_cr_only() {
        let text = "a\r\nb\r\nc";
        let bytes: Vec<u8> = [&[0xFF, 0xFE][..], &text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<_>>()[..]].concat();
        let (_d, bf, _r) = make(&bytes);
        assert_eq!(bf.info().u64_of("lines"), Some(3));
        assert_eq!(lines_of(&bf.read_lines(0, 10).unwrap()), vec!["a", "b", "c"]);
        let (_d2, bf2, _r2) = make(b"x\ry\rz");
        assert_eq!(lines_of(&bf2.read_lines(1, 10).unwrap()), vec!["y", "z"]);
    }

    #[test]
    fn long_lines_are_truncated() {
        let mut s = vec![b'x'; MAX_LINE_BYTES * 3];
        s.extend_from_slice(b"\nfin");
        let (_d, bf, _r) = make(&s);
        let r = bf.read_lines(0, 2).unwrap();
        let l = lines_of(&r);
        assert_eq!(l[0].len(), MAX_LINE_BYTES);
        assert_eq!(l[1], "fin");
        assert_eq!(r.get("truncated").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn search_reports_line_numbers() {
        let mut s = String::new();
        for i in 0..3000 {
            s.push_str(if i % 1000 == 999 { "ERREUR fatale\n" } else { "ok\n" });
        }
        let (_d, bf, _r) = make(s.as_bytes());
        let jobs = crate::jobs::Jobs::new();
        let bf2 = bf.clone();
        let id = jobs.start("bigsearch", move |ctx| bf2.search(&Matcher::new("erreur", false, false), 100, ctx));
        let mut lines = Vec::new();
        loop {
            let r = jobs.poll(id, 2000, 100).unwrap();
            lines.extend(r.get("items").unwrap().as_array().unwrap().iter().map(|i| i.u64_of("line").unwrap()));
            if r.bool_of("done").unwrap() {
                break;
            }
        }
        assert_eq!(lines, vec![1000, 2000, 3000]);
    }

    #[test]
    fn empty_and_pending() {
        let (_d, bf, _r) = make(b"");
        assert_eq!(lines_of(&bf.read_lines(0, 5).unwrap()), vec![""]);
        let d = TempDir::new("big");
        let p = d.join("x.txt");
        std::fs::write(&p, b"a\nb\n").unwrap();
        let reg = BigFiles::default();
        let bf = reg.open(&p, None, false).unwrap();
        // Avant indexation : seule la première ligne est connue.
        assert_eq!(bf.read_lines(5, 1).unwrap().bool_of("pending"), Some(true));
        assert_eq!(lines_of(&bf.read_lines(0, 1).unwrap()), vec!["a"]);
        reg.close(bf.id);
        assert!(reg.get(bf.id).is_err());
    }
}
