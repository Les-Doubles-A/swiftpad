//! Harnais HTTP local : sert l'interface compilée (`dist/`) et transmet les
//! requêtes `POST /rpc` au même noyau que l'application Tauri.
//!
//! Usage réservé au développement et aux tests de bout en bout (Chromium
//! piloté par Playwright). Il n'est pas inclus dans l'application livrée.
//!
//! Sécurité : écoute uniquement sur 127.0.0.1, exige un jeton aléatoire dans
//! l'en-tête `X-SwiftPad-Token` (une page tierce ne peut pas l'envoyer sans
//! requête CORS préalable, à laquelle le harnais ne répond jamais) et
//! vérifie l'en-tête `Host` (protection contre le « DNS rebinding »).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use swiftpad_core::rpc::{Config, Core, Place};

/// Identique à la CSP de `src-tauri/tauri.conf.json` (les tests vérifient
/// ainsi que l'interface fonctionne sous la même politique).
pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const MAX_BODY: usize = 512 * 1024 * 1024;

struct Server {
    core: Arc<Core>,
    dist: PathBuf,
    token: String,
    host: String,
}

fn random_token() -> String {
    // Aléa suffisant pour un jeton local : horloge + adresse de pile + PID,
    // mélangés (pas de dépendance cryptographique dans le noyau).
    let mut x: u64 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
    let local = 0u8;
    x ^= (&local as *const u8 as u64).rotate_left(17) ^ ((std::process::id() as u64) << 32);
    let mut out = String::new();
    for _ in 0..4 {
        // xorshift64*
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        out.push_str(&format!("{:016x}", x.wrapping_mul(0x2545_F491_4F6C_DD1D)));
    }
    out
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = std::str::from_utf8(&b[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nContent-Security-Policy: {CSP}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

impl Server {
    fn handle(&self, mut stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let mut reader = BufReader::new(match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        });
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.is_empty() {
            return;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("/").to_string();
        let mut content_length = 0usize;
        let mut token_ok = false;
        let mut host_ok = false;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).is_err() {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                let v = v.trim();
                match k.to_ascii_lowercase().as_str() {
                    "content-length" => content_length = v.parse().unwrap_or(0),
                    "x-swiftpad-token" => token_ok = v == self.token,
                    "host" => host_ok = v == self.host,
                    _ => {}
                }
            }
        }
        if !host_ok {
            respond(&mut stream, "421 Misdirected Request", "text/plain", b"hote refuse");
            return;
        }
        let path_only = target.split(['?', '#']).next().unwrap_or("/");
        match (method.as_str(), path_only) {
            ("POST", "/rpc") => {
                if !token_ok {
                    respond(&mut stream, "403 Forbidden", "text/plain", b"jeton manquant");
                    return;
                }
                if content_length > MAX_BODY {
                    respond(&mut stream, "413 Payload Too Large", "text/plain", b"trop gros");
                    return;
                }
                let mut body = vec![0u8; content_length];
                if reader.read_exact(&mut body).is_err() {
                    return;
                }
                let out = self.core.handle(&body);
                respond(&mut stream, "200 OK", "application/octet-stream", &out);
            }
            ("GET", p) => self.serve_static(&mut stream, p),
            _ => respond(&mut stream, "405 Method Not Allowed", "text/plain", b"methode"),
        }
    }

    fn serve_static(&self, stream: &mut TcpStream, url_path: &str) {
        let decoded = match percent_decode(url_path) {
            Some(d) => d,
            None => return respond(stream, "400 Bad Request", "text/plain", b"chemin"),
        };
        let rel = decoded.trim_start_matches('/');
        let rel = if rel.is_empty() { "index.html" } else { rel };
        let rel_path = Path::new(rel);
        if rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
            return respond(stream, "400 Bad Request", "text/plain", b"chemin");
        }
        let full = self.dist.join(rel_path);
        match std::fs::read(&full) {
            Ok(bytes) => respond(stream, "200 OK", mime(&full), &bytes),
            Err(_) => respond(stream, "404 Not Found", "text/plain", b"introuvable"),
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut dist = PathBuf::from("dist");
    let mut port: u16 = 0;
    let mut data: Option<PathBuf> = None;
    let mut home: Option<PathBuf> = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let mut token: Option<String> = None;
    let mut open: Vec<String> = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--dist" => dist = args.next().map(PathBuf::from).unwrap_or(dist),
            "--port" => port = args.next().and_then(|p| p.parse().ok()).unwrap_or(0),
            "--data" => data = args.next().map(PathBuf::from),
            "--home" => home = args.next().map(PathBuf::from),
            "--token" => token = args.next(),
            "--open" => open.extend(args.next()),
            "-h" | "--help" => {
                println!("swiftpad-harness --dist <dossier> [--port N] [--data <dossier>] [--home <dossier>] [--token T] [--open <fichier>]");
                return;
            }
            other => open.push(other.to_string()),
        }
    }
    let data = data.unwrap_or_else(|| std::env::temp_dir().join(format!("swiftpad-harness-{}", std::process::id())));
    let mut places = Vec::new();
    if let Some(h) = &home {
        for (label, sub) in [("Bureau", "Desktop"), ("Documents", "Documents"), ("Téléchargements", "Downloads")] {
            let p = h.join(sub);
            if p.is_dir() {
                places.push(Place { label: label.to_string(), path: p });
            }
        }
    }
    let cwd = std::env::current_dir().ok();
    let mut core = Core::new(Config {
        config_dir: data.join("config"),
        data_dir: data.join("data"),
        home_dir: home.clone(),
        places,
        version: env!("CARGO_PKG_VERSION").to_string(),
        launch_files: vec![],
        cwd: cwd.clone(),
    });
    let normalized = core.normalize_launch_args(open);
    if let Some(c) = Arc::get_mut(&mut core) {
        c.cfg.launch_files = normalized;
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("écoute sur 127.0.0.1");
    let addr = listener.local_addr().expect("adresse locale");
    let token = token.unwrap_or_else(random_token);
    let server = Arc::new(Server { core, dist, token: token.clone(), host: format!("127.0.0.1:{}", addr.port()) });
    println!("SWIFTPAD_HARNESS_URL=http://127.0.0.1:{}/index.html?token={}", addr.port(), token);
    let _ = std::io::stdout().flush();
    for stream in listener.incoming().flatten() {
        let s = server.clone();
        std::thread::spawn(move || s.handle(stream));
    }
}
