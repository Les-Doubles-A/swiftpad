//! Fins de ligne : détection (avec comptage des types mélangés) et noms.

use crate::bytes::memchr2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eol {
    Lf,
    CrLf,
    Cr,
}

impl Eol {
    pub fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::CrLf => "\r\n",
            Eol::Cr => "\r",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Eol::Lf => "lf",
            Eol::CrLf => "crlf",
            Eol::Cr => "cr",
        }
    }

    pub fn from_id(s: &str) -> Option<Eol> {
        match s.to_ascii_lowercase().as_str() {
            "lf" => Some(Eol::Lf),
            "crlf" => Some(Eol::CrLf),
            "cr" => Some(Eol::Cr),
            _ => None,
        }
    }

    pub fn platform_default() -> Eol {
        if cfg!(windows) {
            Eol::CrLf
        } else {
            Eol::Lf
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EolStats {
    pub crlf: u64,
    pub lf: u64,
    pub cr: u64,
}

impl EolStats {
    /// Compte les fins de ligne d'un texte ASCII-compatible (UTF-8 ou
    /// Windows-1252 : 0x0A et 0x0D n'apparaissent jamais dans une séquence
    /// multi-octets UTF-8).
    pub fn scan(bytes: &[u8]) -> EolStats {
        let mut st = EolStats::default();
        let mut i = 0;
        let n = bytes.len();
        while i < n {
            match memchr2(b'\r', b'\n', &bytes[i..]) {
                None => break,
                Some(p) => {
                    let at = i + p;
                    if bytes[at] == b'\n' {
                        st.lf += 1;
                        i = at + 1;
                    } else if at + 1 < n && bytes[at + 1] == b'\n' {
                        st.crlf += 1;
                        i = at + 2;
                    } else {
                        st.cr += 1;
                        i = at + 1;
                    }
                }
            }
        }
        st
    }

    pub fn total(&self) -> u64 {
        self.crlf + self.lf + self.cr
    }

    pub fn kinds(&self) -> usize {
        [self.crlf, self.lf, self.cr].iter().filter(|&&c| c > 0).count()
    }

    pub fn is_mixed(&self) -> bool {
        self.kinds() > 1
    }

    /// Type majoritaire ; `default` si le texte n'a aucune fin de ligne.
    pub fn dominant(&self, default: Eol) -> Eol {
        if self.total() == 0 {
            return default;
        }
        let mut best = (Eol::CrLf, self.crlf);
        for (e, c) in [(Eol::Lf, self.lf), (Eol::Cr, self.cr)] {
            if c > best.1 {
                best = (e, c);
            }
        }
        best.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_counts() {
        let s = EolStats::scan(b"a\r\nb\nc\rd\r\n\r\n\n");
        assert_eq!(s, EolStats { crlf: 3, lf: 2, cr: 1 });
        assert!(s.is_mixed());
        assert_eq!(s.dominant(Eol::Lf), Eol::CrLf);
        assert_eq!(EolStats::scan(b"abc").dominant(Eol::Lf), Eol::Lf);
        assert_eq!(EolStats::scan(b"x\r").cr, 1);
        assert_eq!(EolStats::scan(b"\r\r\n").cr, 1);
        assert!(!EolStats::scan(b"a\nb\n").is_mixed());
    }

    #[test]
    fn ids() {
        for e in [Eol::Lf, Eol::CrLf, Eol::Cr] {
            assert_eq!(Eol::from_id(e.id()), Some(e));
        }
        assert_eq!(Eol::from_id("CRLF"), Some(Eol::CrLf));
        assert_eq!(Eol::from_id("x"), None);
    }

    #[test]
    fn utf8_multibyte_never_confused() {
        // « ĉ » = C4 89, « Ċ » = C4 8A : aucun octet 0x0A/0x0D.
        let s = "ĉĊ\u{0A0D}\n".as_bytes();
        assert_eq!(EolStats::scan(s), EolStats { crlf: 0, lf: 1, cr: 0 });
    }
}
