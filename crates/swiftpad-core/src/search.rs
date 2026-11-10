//! Recherche d'un motif littéral dans une ligne (visionneuse de gros
//! fichiers) : sensible ou non à la casse, mot entier, colonnes en unités
//! UTF-16 comme dans l'éditeur.

/// Repliement de casse caractère par caractère (préserve le nombre de
/// caractères, donc les colonnes).
fn fold_char(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Recherche d'un motif littéral dans une ligne.
pub struct Matcher {
    needle: Vec<char>,
    needle_str: String,
    case_sensitive: bool,
    whole_word: bool,
    ascii_needle: bool,
}

impl Matcher {
    pub fn new(query: &str, case_sensitive: bool, whole_word: bool) -> Matcher {
        let needle: Vec<char> = if case_sensitive { query.chars().collect() } else { query.chars().map(fold_char).collect() };
        let needle_str: String = needle.iter().collect();
        Matcher { ascii_needle: needle_str.is_ascii(), needle, needle_str, case_sensitive, whole_word }
    }

    /// Correspondances dans `line` : (début, longueur) en unités UTF-16,
    /// comme l'attend l'éditeur (JavaScript).
    pub fn find_all(&self, line: &str, limit: usize) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        if self.needle.is_empty() || limit == 0 {
            return out;
        }
        let kelvin = !self.case_sensitive && self.needle_str.contains('k') && !line.is_ascii() && line.contains('\u{212A}');
        if self.ascii_needle && !kelvin {
            // Chemin rapide, sans allocation : un motif ASCII ne peut
            // correspondre qu'à des octets ASCII (le signe kelvin U+212A est
            // le seul caractère non ASCII dont la minuscule est ASCII, « k » ;
            // il est traité par le chemin général), donc chaque
            // correspondance commence et finit sur une frontière de
            // caractère. Colonnes converties en unités UTF-16 au besoin.
            let bytes = line.as_bytes();
            let nb = self.needle_str.as_bytes();
            let n = nb.len();
            let ascii_line = line.is_ascii();
            let (mut seen_byte, mut seen16) = (0usize, 0usize);
            let mut from = 0;
            while from + n <= bytes.len() {
                let found = if self.case_sensitive { crate::bytes::find(nb, &bytes[from..]) } else { find_ascii_ci(nb, &bytes[from..]) };
                let Some(p) = found else { break };
                let at = from + p;
                let ok = !self.whole_word
                    || (line[..at].chars().next_back().map_or(true, |c| !is_word_char(c)) && line[at + n..].chars().next().map_or(true, |c| !is_word_char(c)));
                if ok {
                    let start16 = if ascii_line {
                        at
                    } else {
                        seen16 += line[seen_byte..at].chars().map(char::len_utf16).sum::<usize>();
                        seen_byte = at;
                        seen16
                    };
                    out.push((start16, n));
                    if out.len() >= limit {
                        break;
                    }
                    // Correspondances sans chevauchement (comme les éditeurs usuels).
                    from = at + n;
                } else {
                    from = at + 1;
                }
            }
            return out;
        }
        self.find_all_chars(line, limit)
    }

    /// Chemin général, caractère par caractère (motif non ASCII, ou signe
    /// kelvin présent). Sert aussi de référence aux tests du chemin rapide.
    fn find_all_chars(&self, line: &str, limit: usize) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        if self.needle.is_empty() || limit == 0 {
            return out;
        }
        let chars: Vec<char> = if self.case_sensitive { line.chars().collect() } else { line.chars().map(fold_char).collect() };
        let orig: Vec<char> = line.chars().collect();
        let m = self.needle.len();
        if m > chars.len() {
            return out;
        }
        let mut i = 0;
        while i + m <= chars.len() {
            if chars[i..i + m] == self.needle[..] {
                let ok = !self.whole_word
                    || ((i == 0 || !is_word_char(orig[i - 1])) && (i + m >= orig.len() || !is_word_char(orig[i + m])));
                if ok {
                    let start16: usize = orig[..i].iter().map(|c| c.len_utf16()).sum();
                    let len16: usize = orig[i..i + m].iter().map(|c| c.len_utf16()).sum();
                    out.push((start16, len16));
                    if out.len() >= limit {
                        break;
                    }
                    i += m;
                    continue;
                }
            }
            i += 1;
        }
        out
    }
}

/// Première position de `needle` (ASCII, déjà en minuscules) dans `hay`,
/// sans tenir compte de la casse ASCII. Les octets non ASCII ne
/// correspondent jamais.
fn find_ascii_ci(needle: &[u8], hay: &[u8]) -> Option<usize> {
    let Some(&first) = needle.first() else { return Some(0) };
    let (lo, up) = (first, first.to_ascii_uppercase());
    let mut from = 0;
    while from + needle.len() <= hay.len() {
        let at = from + crate::bytes::memchr2(lo, up, &hay[from..])?;
        if at + needle.len() > hay.len() {
            return None;
        }
        if hay[at..at + needle.len()].eq_ignore_ascii_case(needle) {
            return Some(at);
        }
        from = at + 1;
    }
    None
}

/// Extrait d'une ligne autour d'une correspondance, et position de celle-ci
/// dans l'extrait (unités UTF-16, tabulations remplacées par 4 espaces).
pub fn preview(line: &str, start16: usize, len16: usize) -> (String, usize) {
    // Extrait d'au plus ~160 caractères autour de la correspondance.
    const MAX: usize = 160;
    let chars: Vec<char> = line.chars().collect();
    // Index en caractères de la correspondance.
    let mut acc = 0;
    let mut ci = 0;
    while ci < chars.len() && acc < start16 {
        acc += chars[ci].len_utf16();
        ci += 1;
    }
    let mut m_len = 0;
    let mut acc2 = 0;
    while ci + m_len < chars.len() && acc2 < len16 {
        acc2 += chars[ci + m_len].len_utf16();
        m_len += 1;
    }
    let before = 40.min(ci);
    let from = ci - before;
    let to = (from + MAX).max(ci + m_len).min(chars.len());
    let text: String = chars[from..to].iter().collect::<String>().replace('\t', "    ");
    let offset16: usize = chars[from..ci].iter().map(|c| if *c == '\t' { 4 } else { c.len_utf16() }).sum();
    (text, offset16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_ascii_and_unicode() {
        let m = Matcher::new("été", false, false);
        assert_eq!(m.find_all("Un ÉTÉ chaud, été", 10), vec![(3, 3), (14, 3)]);
        let m = Matcher::new("foo", true, false);
        assert_eq!(m.find_all("Foo foo foofoo", 10), vec![(4, 3), (8, 3), (11, 3)]);
        let m = Matcher::new("foo", false, true);
        assert_eq!(m.find_all("Foo foo foofoo _foo", 10), vec![(0, 3), (4, 3)]);
        // Colonnes en unités UTF-16 après un émoji.
        let m = Matcher::new("x", false, false);
        assert_eq!(m.find_all("😀x", 10), vec![(2, 1)]);
        let m = Matcher::new("aa", false, false);
        assert_eq!(m.find_all("aaaa", 10), vec![(0, 2), (2, 2)]);
        assert_eq!(Matcher::new("éé", false, false).find_all("ééé", 10), vec![(0, 2)]);
        assert!(Matcher::new("", false, false).find_all("abc", 10).is_empty());
    }

    /// Test différentiel : le chemin rapide (octets) donne exactement les
    /// mêmes correspondances que le chemin général (caractères), sur des
    /// lignes pseudo-aléatoires mêlant ASCII, accents, émojis et kelvin.
    #[test]
    fn fast_path_matches_reference() {
        let alphabet = ["a", "A", "b", "B", "k", "K", "\u{212A}", "é", "É", "_", " ", "😀", "ß", "1", "-"];
        let queries = ["a", "ab", "AB", "ka", "bk", "a_", "b1", "aa", "-a", "k"];
        let mut r: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            r ^= r << 13;
            r ^= r >> 7;
            r ^= r << 17;
            r
        };
        for _ in 0..4000 {
            let len = (next() % 24) as usize;
            let line: String = (0..len).map(|_| alphabet[(next() % alphabet.len() as u64) as usize]).collect();
            for q in queries {
                for cs in [false, true] {
                    for ww in [false, true] {
                        let m = Matcher::new(q, cs, ww);
                        for limit in [1, 3, 1000] {
                            assert_eq!(m.find_all(&line, limit), m.find_all_chars(&line, limit), "{q:?} dans {line:?} (casse {cs}, mot {ww}, limite {limit})");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn preview_window() {
        let line = format!("{}MATCH{}", "a".repeat(100), "b".repeat(300));
        let (pv, off) = preview(&line, 100, 5);
        assert!(pv.len() <= 170);
        assert_eq!(&pv[off..off + 5], "MATCH");
    }
}
