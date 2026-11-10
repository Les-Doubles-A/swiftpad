//! Banc d'essai reproductible du noyau SwiftPad.
//!
//! Mesure le chemin complet d'une requête de l'interface (encodage de la
//! requête binaire → `Core::handle` → décodage de la réponse), c'est-à-dire
//! tout sauf le transport IPC de Tauri. Les fichiers sont générés dans un
//! dossier temporaire puis supprimés.
//!
//! Usage : cargo run --release --example bench -- [--out bench.json] [--runs 7] [--quick]
//!
//! Limites, à lire avec les chiffres :
//! * cache disque CHAUD (les fichiers viennent d'être écrits) : une première
//!   ouverture après redémarrage de la machine sera plus lente ;
//! * médiane de N exécutions, min et max donnés pour juger de la dispersion.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use swiftpad_core::json::{Json, Obj};
use swiftpad_core::rpc::{call, Config, Core};

struct Args {
    out: Option<PathBuf>,
    runs: usize,
    quick: bool,
}

fn parse_args() -> Args {
    let mut a = Args { out: None, runs: 7, quick: false };
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--out" => a.out = it.next().map(PathBuf::from),
            "--runs" => a.runs = it.next().and_then(|s| s.parse().ok()).unwrap_or(7).max(1),
            "--quick" => a.quick = true,
            _ => {
                eprintln!("argument inconnu : {x}");
                std::process::exit(2);
            }
        }
    }
    a
}

/// Texte réaliste : lignes de longueurs variées, accents, indentation.
fn sample_text(bytes: usize, seed: u64) -> String {
    let words = ["fonction", "valeur", "retour", "élément", "liste", "index", "paramètre", "résultat", "fichier", "chemin", "données", "if", "let", "const", "return", "self", "=>", "{", "}", "(x)", "0x1F", "// note", "TODO", "café", "naïve"];
    let mut s = String::with_capacity(bytes + 128);
    let mut r = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let mut next = || {
        r ^= r << 13;
        r ^= r >> 7;
        r ^= r << 17;
        r
    };
    let mut line = 0u64;
    while s.len() < bytes {
        let indent = (next() % 4) as usize * 4;
        for _ in 0..indent {
            s.push(' ');
        }
        let n = 2 + (next() % 12) as usize;
        for i in 0..n {
            if i > 0 {
                s.push(' ');
            }
            s.push_str(words[(next() % words.len() as u64) as usize]);
        }
        if line % 97 == 0 {
            s.push_str(" aiguille");
        }
        s.push('\n');
        line += 1;
    }
    s
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

struct Results {
    rows: Vec<Json>,
}

impl Results {
    fn add(&mut self, name: &str, detail: &str, samples: Vec<f64>) {
        let min = samples.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = samples.iter().cloned().fold(0.0, f64::max);
        let med = median(samples.clone());
        println!("{name:<46} {detail:<30} médiane {med:>9.2} ms   (min {min:.2}, max {max:.2}, n={})", samples.len());
        self.rows.push(Obj::new().put("name", name).put("detail", detail).put("medianMs", round2(med)).put("minMs", round2(min)).put("maxMs", round2(max)).put("runs", samples.len()).build());
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn time<F: FnMut()>(runs: usize, mut f: F) -> Vec<f64> {
    f(); // préchauffage (allocations, cache)
    (0..runs)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed().as_secs_f64() * 1000.0
        })
        .collect()
}

fn p(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn rpc(core: &Core, cmd: &str, args: Json, payload: &[u8]) -> (Json, Vec<u8>) {
    match call(core, cmd, args, payload) {
        Ok(r) => r,
        Err(e) => panic!("{cmd} : {e}"),
    }
}

/// Attend la fin d'une tâche de fond ; renvoie le nombre d'éléments reçus.
fn wait_job(core: &Core, id: u64) -> (usize, Json) {
    let mut items = 0;
    loop {
        let (r, _) = rpc(core, "job.poll", Obj::new().put("id", id).put("waitMs", 1000u64).put("max", 100_000u64).build(), &[]);
        items += r.get("items").and_then(Json::as_array).map(|a| a.len()).unwrap_or(0);
        if r.bool_of("done") == Some(true) {
            if let Some(e) = r.get("error") {
                if !matches!(e, Json::Null) {
                    panic!("tâche en erreur : {e}");
                }
            }
            return (items, r.get("result").cloned().unwrap_or(Json::Null));
        }
    }
}

fn machine_info() -> Json {
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let mut cpu = std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default();
    if cpu.is_empty() {
        if let Ok(s) = fs::read_to_string("/proc/cpuinfo") {
            if let Some(l) = s.lines().find(|l| l.starts_with("model name")) {
                cpu = l.split(':').nth(1).unwrap_or("").trim().to_string();
            }
        }
    }
    Obj::new()
        .put("os", std::env::consts::OS)
        .put("arch", std::env::consts::ARCH)
        .put("logicalCpus", cpus)
        .put("cpu", cpu)
        .put("profile", if cfg!(debug_assertions) { "debug" } else { "release" })
        .build()
}

fn main() {
    let args = parse_args();
    let runs = args.runs;
    let root = std::env::temp_dir().join(format!("swiftpad-bench-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let core = Core::new(Config {
        config_dir: root.join("config"),
        data_dir: root.join("data"),
        home_dir: Some(root.clone()),
        places: Vec::new(),
        version: "bench".into(),
        launch_files: Vec::new(),
        cwd: None,
    });
    let mut res = Results { rows: Vec::new() };
    println!("SwiftPad — banc d'essai du noyau ({} exécutions, cache disque chaud)\n", runs);

    // --- ouverture de documents texte (doc.open : lecture + détection + décodage + EOL)
    let files = root.join("files");
    fs::create_dir_all(&files).unwrap();
    let sizes: &[(&str, usize)] = if args.quick { &[("1 Ko", 1 << 10), ("1 Mo", 1 << 20)] } else { &[("1 Ko", 1 << 10), ("100 Ko", 100 << 10), ("1 Mo", 1 << 20), ("2 Mo", 2 << 20), ("10 Mo", 10 << 20)] };
    for (label, size) in sizes {
        let f = files.join(format!("utf8-{size}.txt"));
        fs::write(&f, sample_text(*size, *size as u64)).unwrap();
        let s = time(runs, || {
            let (h, body) = rpc(&core, "doc.open", Obj::new().put("path", p(&f)).build(), &[]);
            assert!(!body.is_empty() && h.str_of("encoding").is_some());
        });
        res.add("doc.open UTF-8", label, s);
    }
    // Encodages non UTF-8 (conversion complète).
    {
        let text = sample_text(1 << 20, 7);
        let crlf = text.replace('\n', "\r\n");
        let f = files.join("crlf.txt");
        fs::write(&f, &crlf).unwrap();
        res.add("doc.open UTF-8 CRLF", "1 Mo", time(runs, || {
            rpc(&core, "doc.open", Obj::new().put("path", p(&f)).build(), &[]);
        }));
        let mut u16 = vec![0xFF, 0xFE];
        for c in text.encode_utf16() {
            u16.extend_from_slice(&c.to_le_bytes());
        }
        let f = files.join("utf16.txt");
        fs::write(&f, &u16).unwrap();
        res.add("doc.open UTF-16 LE (BOM)", "2 Mo sur disque", time(runs, || {
            rpc(&core, "doc.open", Obj::new().put("path", p(&f)).build(), &[]);
        }));
        let latin: Vec<u8> = text.chars().map(|c| match c {
            'é' => 0xE9,
            'ï' => 0xEF,
            'è' => 0xE8,
            c if (c as u32) < 128 => c as u8,
            _ => b'?',
        }).collect();
        let f = files.join("ansi.txt");
        fs::write(&f, &latin).unwrap();
        res.add("doc.open Windows-1252", "≈1 Mo", time(runs, || {
            let (h, _) = rpc(&core, "doc.open", Obj::new().put("path", p(&f)).build(), &[]);
            assert_eq!(h.str_of("encoding"), Some("windows-1252"));
        }));
    }

    // --- enregistrement atomique (fichier temporaire + fsync + remplacement)
    {
        let text = sample_text(1 << 20, 11);
        let f = files.join("save.txt");
        fs::write(&f, &text).unwrap();
        res.add("doc.save atomique UTF-8 CRLF", "1 Mo", time(runs, || {
            rpc(&core, "doc.save", Obj::new().put("path", p(&f)).put("encoding", "utf-8").put("eol", "crlf").put("force", true).build(), text.as_bytes());
        }));
    }

    // --- gros fichier : ouverture du lecteur, index des lignes, lecture d'une
    // page, recherche dans tout le fichier (big.search + job.poll)
    {
        let mb = if args.quick { 20 } else { 100 };
        let f = files.join("big.log");
        {
            let mut w = std::io::BufWriter::new(fs::File::create(&f).unwrap());
            let chunk = sample_text(1 << 20, 99);
            for _ in 0..mb {
                w.write_all(chunk.as_bytes()).unwrap();
            }
        }
        let detail = format!("{mb} Mo");
        let mut first_page = Vec::new();
        let mut index_ms = Vec::new();
        let mut lines_total = 0u64;
        let mut search_ms = Vec::new();
        let mut found = 0usize;
        for _ in 0..runs.min(5) {
            let t = Instant::now();
            let (r, _) = rpc(&core, "big.open", Obj::new().put("path", p(&f)).build(), &[]);
            let id = r.get("info").and_then(|i| i.u64_of("id")).unwrap();
            let (page, _) = rpc(&core, "big.lines", Obj::new().put("id", id).put("start", 0u64).put("count", 200u64).build(), &[]);
            assert!(page.get("lines").and_then(Json::as_array).map(|a| !a.is_empty()).unwrap_or(false));
            first_page.push(t.elapsed().as_secs_f64() * 1000.0);
            let (_, _) = wait_job(&core, r.u64_of("jobId").unwrap());
            index_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            let (info, _) = rpc(&core, "big.info", Obj::new().put("id", id).build(), &[]);
            lines_total = info.u64_of("lines").unwrap_or(0);
            // Page au milieu du fichier (index clairsemé : relecture locale).
            let mid = lines_total / 2;
            let t2 = Instant::now();
            rpc(&core, "big.lines", Obj::new().put("id", id).put("start", mid).put("count", 200u64).build(), &[]);
            let _ = t2.elapsed();
            let t3 = Instant::now();
            let (r, _) = rpc(&core, "big.search", Obj::new().put("id", id).put("query", "aiguille").put("maxResults", 1_000_000u64).build(), &[]);
            found = wait_job(&core, r.u64_of("jobId").unwrap()).0;
            search_ms.push(t3.elapsed().as_secs_f64() * 1000.0);
            rpc(&core, "big.close", Obj::new().put("id", id).build(), &[]);
        }
        res.add("lecteur gros fichier : 200 premières lignes", &detail, first_page);
        res.add("lecteur gros fichier : index complet", &format!("{detail}, {lines_total} lignes"), index_ms);
        res.add("lecteur gros fichier : recherche (texte simple)", &detail, search_ms);
        println!("{:>46} correspondances reçues : {found}", "");
    }

    let out = Obj::new()
        .put("tool", "swiftpad-core examples/bench.rs")
        .put("date", swiftpad_core::time::now_ms())
        .put("machine", machine_info())
        .put("cache", "chaud")
        .put("results", Json::Arr(res.rows))
        .build();
    if let Some(path) = &args.out {
        fs::write(path, out.to_string()).unwrap();
        println!("\nRésultats écrits dans {}", path.display());
    }
    let _ = fs::remove_dir_all(&root);
    std::thread::sleep(Duration::from_millis(10));
}
