//! Encodages : détection, décodage sans perte silencieuse, réencodage.
//!
//! Pris en charge : UTF-8 (avec ou sans BOM), UTF-16 LE/BE (avec BOM, ou
//! sans BOM par heuristique signalée comme incertaine) et Windows-1252
//! (« ANSI » des Windows occidentaux), utilisé en dernier recours.
//!
//! Garanties :
//! * Windows-1252 est décodé de façon réversible : les 5 octets non définis
//!   (0x81, 0x8D, 0x8F, 0x90, 0x9D) deviennent les contrôles C1 de même
//!   valeur, si bien que n'importe quelle suite d'octets est restituée à
//!   l'identique à l'enregistrement.
//! * Toute substitution (octets UTF-8 invalides, substituts UTF-16 isolés)
//!   est comptée et remontée à l'interface : rien n'est perdu en silence.
//! * Un caractère impossible à représenter dans l'encodage cible bloque
//!   l'enregistrement avec sa position, au lieu d'être remplacé par « ? ».

use crate::eol::Eol;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Charset {
    Utf8,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Encoding {
    pub charset: Charset,
    pub bom: bool,
}

impl Encoding {
    pub const UTF8: Encoding = Encoding { charset: Charset::Utf8, bom: false };
    pub const UTF8_BOM: Encoding = Encoding { charset: Charset::Utf8, bom: true };
    pub const UTF16LE: Encoding = Encoding { charset: Charset::Utf16Le, bom: true };
    pub const UTF16BE: Encoding = Encoding { charset: Charset::Utf16Be, bom: true };
    pub const WINDOWS1252: Encoding = Encoding { charset: Charset::Windows1252, bom: false };

    pub fn id(self) -> &'static str {
        match (self.charset, self.bom) {
            (Charset::Utf8, false) => "utf-8",
            (Charset::Utf8, true) => "utf-8-bom",
            (Charset::Utf16Le, true) => "utf-16le",
            (Charset::Utf16Le, false) => "utf-16le-nobom",
            (Charset::Utf16Be, true) => "utf-16be",
            (Charset::Utf16Be, false) => "utf-16be-nobom",
            (Charset::Windows1252, _) => "windows-1252",
        }
    }

    pub fn from_id(s: &str) -> Option<Encoding> {
        Some(match s.to_ascii_lowercase().as_str() {
            "utf-8" | "utf8" => Encoding::UTF8,
            "utf-8-bom" | "utf8bom" => Encoding::UTF8_BOM,
            "utf-16le" | "utf-16" => Encoding::UTF16LE,
            "utf-16le-nobom" => Encoding { charset: Charset::Utf16Le, bom: false },
            "utf-16be" => Encoding::UTF16BE,
            "utf-16be-nobom" => Encoding { charset: Charset::Utf16Be, bom: false },
            "windows-1252" | "cp1252" | "ansi" => Encoding::WINDOWS1252,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match (self.charset, self.bom) {
            (Charset::Utf8, false) => "UTF-8",
            (Charset::Utf8, true) => "UTF-8 avec BOM",
            (Charset::Utf16Le, true) => "UTF-16 LE",
            (Charset::Utf16Le, false) => "UTF-16 LE sans BOM",
            (Charset::Utf16Be, true) => "UTF-16 BE",
            (Charset::Utf16Be, false) => "UTF-16 BE sans BOM",
            (Charset::Windows1252, _) => "Windows-1252 (ANSI)",
        }
    }

    pub fn bom_bytes(self) -> &'static [u8] {
        match (self.charset, self.bom) {
            (Charset::Utf8, true) => &[0xEF, 0xBB, 0xBF],
            (Charset::Utf16Le, true) => &[0xFF, 0xFE],
            (Charset::Utf16Be, true) => &[0xFE, 0xFF],
            _ => &[],
        }
    }
}

/// Fiabilité de la détection, transmise telle quelle à l'interface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confidence {
    /// Marque d'ordre des octets (BOM) présente : certain.
    Bom,
    /// UTF-8 valide contenant des caractères non ASCII : quasi certain.
    Valid,
    /// Uniquement de l'ASCII : compatible avec tous les encodages proposés.
    Ascii,
    /// UTF-16 sans BOM reconnu par la répartition des octets nuls : probable.
    Heuristic,
    /// Ni UTF-8 ni UTF-16 : Windows-1252 supposé, incertain.
    Fallback,
    /// Choisi explicitement par l'utilisateur.
    Forced,
}

impl Confidence {
    pub fn id(self) -> &'static str {
        match self {
            Confidence::Bom => "bom",
            Confidence::Valid => "valid",
            Confidence::Ascii => "ascii",
            Confidence::Heuristic => "heuristic",
            Confidence::Fallback => "fallback",
            Confidence::Forced => "forced",
        }
    }

    pub fn is_uncertain(self) -> bool {
        matches!(self, Confidence::Heuristic | Confidence::Fallback)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Detection {
    pub encoding: Encoding,
    pub confidence: Confidence,
}

pub fn detect(bytes: &[u8]) -> Detection {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Detection { encoding: Encoding::UTF8_BOM, confidence: Confidence::Bom };
    }
    if bytes.starts_with(&[0xFF, 0xFE]) && !bytes.starts_with(&[0xFF, 0xFE, 0, 0]) {
        return Detection { encoding: Encoding::UTF16LE, confidence: Confidence::Bom };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Detection { encoding: Encoding::UTF16BE, confidence: Confidence::Bom };
    }
    // De l'UTF-16 « ASCII » est aussi de l'UTF-8 valide (les octets nuls sont
    // autorisés) : l'heuristique UTF-16 passe donc avant la validation UTF-8
    // dès que l'échantillon contient des octets nuls.
    if bytes[..bytes.len().min(64 * 1024)].contains(&0) {
        if let Some(cs) = utf16_heuristic(bytes) {
            return Detection { encoding: Encoding { charset: cs, bom: false }, confidence: Confidence::Heuristic };
        }
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => {
            let c = if s.is_ascii() { Confidence::Ascii } else { Confidence::Valid };
            return Detection { encoding: Encoding::UTF8, confidence: c };
        }
        Err(e) => {
            // Seule une séquence tronquée en toute fin de fichier (fichier en
            // cours d'écriture, copie interrompue) : reste de l'UTF-8, mais
            // seulement si le début contient de vraies séquences UTF-8.
            // Sinon (« caf\xE9 » en ANSI se termine aussi par un octet isolé),
            // Windows-1252 est bien plus probable.
            if e.error_len().is_none() && e.valid_up_to() > 0 && bytes.len() - e.valid_up_to() <= 3 {
                let head = &bytes[..e.valid_up_to()];
                if !head.is_ascii() {
                    return Detection { encoding: Encoding::UTF8, confidence: Confidence::Valid };
                }
            }
        }
    }
    Detection { encoding: Encoding::WINDOWS1252, confidence: Confidence::Fallback }
}

fn utf16_heuristic(bytes: &[u8]) -> Option<Charset> {
    if bytes.len() < 4 || bytes.len() % 2 != 0 {
        return None;
    }
    let sample = &bytes[..bytes.len().min(64 * 1024)];
    let pairs = sample.len() / 2;
    let (mut z_even, mut z_odd) = (0usize, 0usize);
    for (i, &b) in sample.iter().enumerate() {
        if b == 0 {
            if i % 2 == 0 {
                z_even += 1;
            } else {
                z_odd += 1;
            }
        }
    }
    let cs = if z_odd * 10 >= pairs * 3 && z_even * 50 <= pairs {
        Charset::Utf16Le
    } else if z_even * 10 >= pairs * 3 && z_odd * 50 <= pairs {
        Charset::Utf16Be
    } else {
        return None;
    };
    // Vérifie que l'échantillon se décode proprement (pas de substituts isolés,
    // pas de caractère nul) avant de conclure.
    let units = sample.chunks_exact(2).map(|c| match cs {
        Charset::Utf16Le => u16::from_le_bytes([c[0], c[1]]),
        _ => u16::from_be_bytes([c[0], c[1]]),
    });
    let mut bad = 0usize;
    for r in char::decode_utf16(units) {
        match r {
            Ok('\0') | Err(_) => bad += 1,
            Ok(_) => {}
        }
    }
    if bad * 100 > pairs {
        None
    } else {
        Some(cs)
    }
}

/// Signatures de formats binaires courants.
const MAGIC: &[(&[u8], &str)] = &[
    (b"\x89PNG\r\n\x1a\n", "image PNG"),
    (b"\xFF\xD8\xFF", "image JPEG"),
    (b"GIF87a", "image GIF"),
    (b"GIF89a", "image GIF"),
    (b"II*\x00", "image TIFF"),
    (b"MM\x00*", "image TIFF"),
    (b"%PDF-", "document PDF"),
    (b"PK\x03\x04", "archive ZIP (ou document Office)"),
    (b"PK\x05\x06", "archive ZIP"),
    (b"\x1F\x8B", "archive GZIP"),
    (b"7z\xBC\xAF\x27\x1C", "archive 7-Zip"),
    (b"Rar!\x1A\x07", "archive RAR"),
    (b"\x7FELF", "exécutable ELF"),
    (b"SQLite format 3\x00", "base de données SQLite"),
    (b"\x00asm", "module WebAssembly"),
    (b"\xCA\xFE\xBA\xBE", "classe Java"),
    (b"OggS", "audio Ogg"),
    (b"ID3", "audio MP3"),
    (b"fLaC", "audio FLAC"),
    (b"\xFF\xFE\x00\x00", "texte UTF-32 (non pris en charge)"),
    (b"\x00\x00\xFE\xFF", "texte UTF-32 (non pris en charge)"),
];

/// Indique si le contenu semble binaire (et pourquoi). L'analyse porte sur
/// le début, le milieu et la fin du fichier, jamais sur sa totalité.
pub fn sniff_binary(bytes: &[u8], enc: Encoding) -> Option<&'static str> {
    for (sig, what) in MAGIC {
        if bytes.starts_with(sig) {
            return Some(what);
        }
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" {
        return Some(match &bytes[8..12] {
            b"WEBP" => "image WebP",
            b"WAVE" => "audio WAV",
            b"AVI " => "vidéo AVI",
            _ => "fichier RIFF",
        });
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some("vidéo ou audio MP4");
    }
    if bytes.starts_with(b"MZ") && bytes.iter().take(64).any(|&b| b == 0) {
        return Some("exécutable Windows");
    }
    let samples: Vec<&[u8]> = sample_windows(bytes);
    match enc.charset {
        Charset::Utf16Le | Charset::Utf16Be => {
            for s in samples {
                let s = &s[..s.len() & !1];
                let le = enc.charset == Charset::Utf16Le;
                let skip_bom = std::ptr::eq(s.as_ptr(), bytes.as_ptr()) && enc.bom;
                let nul = s
                    .chunks_exact(2)
                    .skip(skip_bom as usize)
                    .any(|c| (if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }) == 0);
                if nul {
                    return Some("contient des caractères nuls");
                }
            }
            None
        }
        _ => {
            for s in samples {
                if s.contains(&0) {
                    return Some("contient des octets nuls");
                }
                let ctrl = s
                    .iter()
                    .filter(|&&b| matches!(b, 0x01..=0x08 | 0x0E..=0x19 | 0x1C..=0x1F | 0x7F))
                    .count();
                if ctrl * 20 > s.len() {
                    return Some("contient de nombreux caractères de contrôle");
                }
            }
            None
        }
    }
}

fn sample_windows(bytes: &[u8]) -> Vec<&[u8]> {
    const HEAD: usize = 64 * 1024;
    const PART: usize = 16 * 1024;
    let n = bytes.len();
    if n <= HEAD + 2 * PART {
        return vec![bytes];
    }
    let mid = (n / 2) & !1;
    let tail = (n - PART) & !1;
    vec![&bytes[..HEAD], &bytes[mid..mid + PART], &bytes[tail..]]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    pub text: String,
    /// Nombre de séquences remplacées par U+FFFD (0 = décodage exact).
    pub replaced: usize,
    /// BOM effectivement présente dans les octets (et retirée du texte).
    pub had_bom: bool,
}

/// Décode `bytes`. Pour l'UTF-8 valide, aucune copie n'est faite.
pub fn decode(mut bytes: Vec<u8>, charset: Charset) -> Decoded {
    match charset {
        Charset::Utf8 => {
            let had_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
            if had_bom {
                bytes.drain(..3);
            }
            match String::from_utf8(bytes) {
                Ok(text) => Decoded { text, replaced: 0, had_bom },
                Err(e) => {
                    let bytes = e.into_bytes();
                    let mut text = String::with_capacity(bytes.len() + 16);
                    let mut replaced = 0;
                    for chunk in bytes.utf8_chunks() {
                        text.push_str(chunk.valid());
                        if !chunk.invalid().is_empty() {
                            text.push('\u{FFFD}');
                            replaced += 1;
                        }
                    }
                    Decoded { text, replaced, had_bom }
                }
            }
        }
        Charset::Utf16Le | Charset::Utf16Be => {
            let le = charset == Charset::Utf16Le;
            let bom: &[u8] = if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] };
            let had_bom = bytes.starts_with(bom);
            let body = if had_bom { &bytes[2..] } else { &bytes[..] };
            let mut text = String::with_capacity(body.len() / 2 + body.len() / 8);
            let mut replaced = 0;
            let units = body.chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) });
            for r in char::decode_utf16(units) {
                match r {
                    Ok(c) => text.push(c),
                    Err(_) => {
                        text.push('\u{FFFD}');
                        replaced += 1;
                    }
                }
            }
            if body.len() % 2 == 1 {
                text.push('\u{FFFD}');
                replaced += 1;
            }
            Decoded { text, replaced, had_bom }
        }
        Charset::Windows1252 => {
            let mut text = String::with_capacity(bytes.len() + bytes.len() / 4);
            let mut i = 0;
            while i < bytes.len() {
                // Copie directe des plages ASCII.
                let start = i;
                while i < bytes.len() && bytes[i] < 0x80 {
                    i += 1;
                }
                if i > start {
                    // SAFETY-free : une plage ASCII est de l'UTF-8 valide.
                    text.push_str(std::str::from_utf8(&bytes[start..i]).unwrap_or_default());
                }
                if i < bytes.len() {
                    text.push(cp1252_to_char(bytes[i]));
                    i += 1;
                }
            }
            Decoded { text, replaced: 0, had_bom: false }
        }
    }
}

const CP1252_HIGH: [u16; 32] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D,
    0x017D, 0x008F, 0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A,
    0x0153, 0x009D, 0x017E, 0x0178,
];

fn cp1252_to_char(b: u8) -> char {
    match b {
        0x80..=0x9F => char::from_u32(CP1252_HIGH[(b - 0x80) as usize] as u32).unwrap_or('\u{FFFD}'),
        _ => b as char,
    }
}

fn char_to_cp1252(c: char) -> Option<u8> {
    let u = c as u32;
    if u < 0x80 || (0xA0..=0xFF).contains(&u) {
        return Some(u as u8);
    }
    CP1252_HIGH.iter().position(|&x| x as u32 == u).map(|i| 0x80 + i as u8)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unencodable {
    pub ch: char,
    /// Ligne et colonne (1 = première), en caractères.
    pub line: usize,
    pub column: usize,
    pub count: usize,
}

/// Encode `text` en convertissant chaque fin de ligne (`\n`, `\r\n` ou `\r`)
/// en `eol`, et ajoute la BOM demandée.
pub fn encode(text: &str, enc: Encoding, eol: Eol) -> Result<Vec<u8>, Unencodable> {
    let nl = eol.as_str().as_bytes();
    let mut out = Vec::with_capacity(match enc.charset {
        Charset::Utf16Le | Charset::Utf16Be => text.len() * 2 + 4,
        _ => text.len() + text.len() / 32 + 4,
    });
    out.extend_from_slice(enc.bom_bytes());
    match enc.charset {
        Charset::Utf8 => push_with_eol(text.as_bytes(), nl, &mut out),
        Charset::Windows1252 => {
            let mut bad: Option<Unencodable> = None;
            let (mut line, mut col) = (1usize, 0usize);
            let mut chars = text.chars().peekable();
            while let Some(c) = chars.next() {
                match c {
                    '\r' => {
                        if chars.peek() == Some(&'\n') {
                            chars.next();
                        }
                        out.extend_from_slice(nl);
                        line += 1;
                        col = 0;
                    }
                    '\n' => {
                        out.extend_from_slice(nl);
                        line += 1;
                        col = 0;
                    }
                    _ => {
                        col += 1;
                        match char_to_cp1252(c) {
                            Some(b) => out.push(b),
                            None => match bad.as_mut() {
                                Some(b) => b.count += 1,
                                None => bad = Some(Unencodable { ch: c, line, column: col, count: 1 }),
                            },
                        }
                    }
                }
            }
            if let Some(b) = bad {
                return Err(b);
            }
        }
        Charset::Utf16Le | Charset::Utf16Be => {
            let le = enc.charset == Charset::Utf16Le;
            let push_unit = |u: u16, out: &mut Vec<u8>| {
                if le {
                    out.extend_from_slice(&u.to_le_bytes())
                } else {
                    out.extend_from_slice(&u.to_be_bytes())
                }
            };
            let nl_units: Vec<u16> = eol.as_str().encode_utf16().collect();
            let mut chars = text.chars().peekable();
            let mut buf = [0u16; 2];
            while let Some(c) = chars.next() {
                match c {
                    '\r' | '\n' => {
                        if c == '\r' && chars.peek() == Some(&'\n') {
                            chars.next();
                        }
                        for &u in &nl_units {
                            push_unit(u, &mut out);
                        }
                    }
                    _ => {
                        for &u in c.encode_utf16(&mut buf).iter() {
                            push_unit(u, &mut out);
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Copie `src` dans `out` en remplaçant toute fin de ligne par `nl`.
fn push_with_eol(src: &[u8], nl: &[u8], out: &mut Vec<u8>) {
    if nl == b"\n" && crate::bytes::memchr(b'\r', src).is_none() {
        out.extend_from_slice(src);
        return;
    }
    let mut i = 0;
    while i < src.len() {
        match crate::bytes::memchr2(b'\r', b'\n', &src[i..]) {
            None => {
                out.extend_from_slice(&src[i..]);
                break;
            }
            Some(p) => {
                let at = i + p;
                out.extend_from_slice(&src[i..at]);
                out.extend_from_slice(nl);
                i = if src[at] == b'\r' && src.get(at + 1) == Some(&b'\n') { at + 2 } else { at + 1 };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(bytes: &[u8]) -> (Detection, Vec<u8>) {
        let d = detect(bytes);
        let dec = decode(bytes.to_vec(), d.encoding.charset);
        let enc = Encoding { bom: dec.had_bom || (d.encoding.bom && d.confidence == Confidence::Bom), ..d.encoding };
        // Les fins de ligne sont conservées si l'on réencode avec le type d'origine.
        let stats = crate::eol::EolStats::scan(dec.text.as_bytes());
        let eol = stats.dominant(Eol::Lf);
        (d, encode(&dec.text, enc, eol).unwrap())
    }

    #[test]
    fn detects_boms() {
        assert_eq!(detect(b"\xEF\xBB\xBFabc").encoding, Encoding::UTF8_BOM);
        assert_eq!(detect(b"\xFF\xFEa\x00").encoding, Encoding::UTF16LE);
        assert_eq!(detect(b"\xFE\xFF\x00a").encoding, Encoding::UTF16BE);
        assert_eq!(detect(b"\xFF\xFE\x00\x00").encoding.charset, Charset::Windows1252); // UTF-32 : pas de l'UTF-16
    }

    #[test]
    fn detects_utf8_ascii_and_fallback() {
        let d = detect("Été à Évreux".as_bytes());
        assert_eq!((d.encoding, d.confidence), (Encoding::UTF8, Confidence::Valid));
        assert_eq!(detect(b"plain ascii").confidence, Confidence::Ascii);
        assert_eq!(detect(b"").confidence, Confidence::Ascii);
        let latin = b"caf\xE9 cr\xE8me \x80";
        let d = detect(latin);
        assert_eq!((d.encoding, d.confidence), (Encoding::WINDOWS1252, Confidence::Fallback));
        assert!(d.confidence.is_uncertain());
    }

    #[test]
    fn truncated_utf8_at_end_stays_utf8() {
        let mut b = "déjà".as_bytes().to_vec();
        b.extend_from_slice(&[0xE2, 0x82]); // € tronqué
        let d = detect(&b);
        assert_eq!(d.encoding.charset, Charset::Utf8);
        let dec = decode(b, Charset::Utf8);
        assert_eq!(dec.replaced, 1);
        assert!(dec.text.starts_with("déjà"));
    }

    #[test]
    fn ansi_ending_with_accent_is_not_truncated_utf8() {
        // Non-régression : « café » en ANSI (63 61 66 E9) ressemblait à de
        // l'UTF-8 tronqué ; le début purement ASCII ne prouve rien.
        for bytes in [&b"caf\xE9"[..], &b"c\xE9"[..], &b"ligne\r\nd\xE9but \xE0"[..]] {
            let d = detect(bytes);
            assert_eq!((d.encoding, d.confidence), (Encoding::WINDOWS1252, Confidence::Fallback), "{bytes:?}");
        }
    }

    #[test]
    fn utf16_without_bom_heuristic() {
        let text = "Bonjour le monde, voici un texte assez long.\r\n";
        let le: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let be: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
        let d = detect(&le);
        assert_eq!((d.encoding.charset, d.encoding.bom, d.confidence), (Charset::Utf16Le, false, Confidence::Heuristic));
        assert_eq!(detect(&be).encoding.charset, Charset::Utf16Be);
        assert_eq!(decode(le, Charset::Utf16Le).text, text);
    }

    #[test]
    fn cp1252_is_lossless_for_every_byte() {
        let all: Vec<u8> = (0u8..=255).collect();
        let dec = decode(all.clone(), Charset::Windows1252);
        assert_eq!(dec.replaced, 0);
        // Sans conversion de fins de ligne (LF unique dans l'entrée : 0x0A ; 0x0D isolé).
        let back = encode(&dec.text, Encoding::WINDOWS1252, Eol::Lf).unwrap();
        // 0x0D isolé devient LF : on vérifie octet par octet hors 0x0D.
        let expected: Vec<u8> = all.iter().map(|&b| if b == 0x0D { 0x0A } else { b }).collect();
        assert_eq!(back, expected);
        assert_eq!(decode(vec![0x80], Charset::Windows1252).text, "€");
        assert_eq!(decode(vec![0x81], Charset::Windows1252).text, "\u{81}");
    }

    #[test]
    fn roundtrips_preserve_bytes() {
        let cases: Vec<Vec<u8>> = vec![
            b"simple\r\nlignes\r\n".to_vec(),
            "unix\nété\n".as_bytes().to_vec(),
            [&[0xEF, 0xBB, 0xBF][..], "avec bom\r\n€".as_bytes()].concat(),
            [&[0xFF, 0xFE][..], &"x\r\ny😀".encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<_>>()[..]].concat(),
            [&[0xFE, 0xFF][..], &"z\nw".encode_utf16().flat_map(|u| u.to_be_bytes()).collect::<Vec<_>>()[..]].concat(),
            b"caf\xE9\r\nna\xEFve \x93guillemets\x94\r\n".to_vec(),
            b"mac\rclassique\r".to_vec(),
            Vec::new(),
        ];
        for c in cases {
            let (d, back) = roundtrip(&c);
            assert_eq!(back, c, "aller-retour {:?}", d);
        }
    }

    #[test]
    fn invalid_utf8_counts_replacements() {
        let dec = decode(b"ok \xFF\xFE fin \xC3".to_vec(), Charset::Utf8);
        assert!(dec.replaced >= 2);
        assert!(dec.text.contains('\u{FFFD}'));
    }

    #[test]
    fn lone_surrogates_counted() {
        let units: Vec<u16> = vec![0x0061, 0xD800, 0x0062];
        let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
        let dec = decode(bytes, Charset::Utf16Le);
        assert_eq!(dec.text, "a\u{FFFD}b");
        assert_eq!(dec.replaced, 1);
        let mut odd = vec![0xFF, 0xFE, 0x61, 0x00, 0x62];
        odd.truncate(5);
        assert_eq!(decode(odd, Charset::Utf16Le).replaced, 1);
    }

    #[test]
    fn eol_conversion_on_encode() {
        let t = "a\nb\r\nc\rd";
        assert_eq!(encode(t, Encoding::UTF8, Eol::CrLf).unwrap(), b"a\r\nb\r\nc\r\nd");
        assert_eq!(encode(t, Encoding::UTF8, Eol::Lf).unwrap(), b"a\nb\nc\nd");
        assert_eq!(encode(t, Encoding::UTF8, Eol::Cr).unwrap(), b"a\rb\rc\rd");
        assert_eq!(encode("x\n", Encoding::UTF8_BOM, Eol::Lf).unwrap(), b"\xEF\xBB\xBFx\n");
        let u = encode("a\nb", Encoding::UTF16LE, Eol::CrLf).unwrap();
        assert_eq!(u, vec![0xFF, 0xFE, b'a', 0, b'\r', 0, b'\n', 0, b'b', 0]);
        let u = encode("a", Encoding { charset: Charset::Utf16Be, bom: false }, Eol::Lf).unwrap();
        assert_eq!(u, vec![0, b'a']);
    }

    #[test]
    fn unencodable_reports_position() {
        let err = encode("ok\nun 😀 et ✓", Encoding::WINDOWS1252, Eol::CrLf).unwrap_err();
        assert_eq!(err.ch, '😀');
        assert_eq!((err.line, err.column, err.count), (2, 4, 2));
        assert_eq!(encode("€ et œ", Encoding::WINDOWS1252, Eol::Lf).unwrap(), b"\x80 et \x9C");
    }

    #[test]
    fn binary_sniffing() {
        assert_eq!(sniff_binary(b"\x89PNG\r\n\x1a\nxxxx", Encoding::UTF8), Some("image PNG"));
        assert_eq!(sniff_binary(b"PK\x03\x04....", Encoding::UTF8), Some("archive ZIP (ou document Office)"));
        assert_eq!(sniff_binary(b"text with \0 nul", Encoding::UTF8), Some("contient des octets nuls"));
        let ctrl: Vec<u8> = (0..100).map(|i| if i % 3 == 0 { 0x02 } else { b'a' }).collect();
        assert!(sniff_binary(&ctrl, Encoding::UTF8).is_some());
        assert_eq!(sniff_binary(b"normal text\n\x1b[31mred\x1b[0m\t\x0c", Encoding::UTF8), None);
        let le: Vec<u8> = [&[0xFF, 0xFE][..], &"texte".encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<_>>()[..]].concat();
        assert_eq!(sniff_binary(&le, Encoding::UTF16LE), None);
        let mut le_nul = le.clone();
        le_nul.extend_from_slice(&[0, 0]);
        assert!(sniff_binary(&le_nul, Encoding::UTF16LE).is_some());
        // Binaire caché en fin de gros fichier.
        let mut big = vec![b'a'; 300_000];
        big[299_000] = 0;
        assert!(sniff_binary(&big, Encoding::UTF8).is_some());
    }

    #[test]
    fn ids_roundtrip() {
        for e in [Encoding::UTF8, Encoding::UTF8_BOM, Encoding::UTF16LE, Encoding::UTF16BE, Encoding::WINDOWS1252,
                  Encoding { charset: Charset::Utf16Le, bom: false }, Encoding { charset: Charset::Utf16Be, bom: false }] {
            assert_eq!(Encoding::from_id(e.id()), Some(e));
            assert!(!e.label().is_empty());
        }
        assert_eq!(Encoding::from_id("klingon"), None);
    }
}
