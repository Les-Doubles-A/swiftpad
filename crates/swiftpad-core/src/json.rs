//! JSON minimal (RFC 8259) : analyse et écriture, sans dépendance.
//!
//! Le noyau échange tout son état avec l'interface en JSON. Une
//! implémentation locale garde le noyau compilable hors ligne ; elle est
//! volontairement stricte en lecture (profondeur bornée, pas de caractère
//! de contrôle brut dans les chaînes) et sûre en écriture (échappement de
//! `<`, U+2028 et U+2029 pour pouvoir injecter le résultat dans un script).

use std::fmt;

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Json {
    #[default]
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// Objet : l'ordre des clés est conservé ; une clé en double est
    /// remplacée par sa dernière occurrence (comme `JSON.parse`).
    Obj(Vec<(String, Json)>),
}

/// Profondeur maximale acceptée à l'analyse (protection de la pile).
pub const MAX_DEPTH: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub pos: usize,
    pub msg: &'static str,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JSON invalide à l'octet {} : {}", self.pos, self.msg)
    }
}

impl std::error::Error for ParseError {}

impl Json {
    pub fn parse(src: &str) -> Result<Json, ParseError> {
        let mut p = Parser { s: src.as_bytes(), i: 0, depth: 0 };
        p.ws();
        let v = p.value()?;
        p.ws();
        if p.i != p.s.len() {
            return Err(p.err("contenu inattendu après la valeur"));
        }
        Ok(v)
    }

    pub fn parse_bytes(b: &[u8]) -> Result<Json, ParseError> {
        let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(b);
        match std::str::from_utf8(b) {
            Ok(s) => Json::parse(s),
            Err(e) => Err(ParseError { pos: e.valid_up_to(), msg: "UTF-8 invalide" }),
        }
    }

    pub fn obj() -> Json {
        Json::Obj(Vec::new())
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(v) => v.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        match self {
            Json::Obj(v) => v.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Ajoute ou remplace une clé. Sans effet si `self` n'est pas un objet.
    pub fn set(&mut self, key: &str, value: impl Into<Json>) {
        if let Json::Obj(v) = self {
            let value = value.into();
            if let Some(slot) = v.iter_mut().find(|(k, _)| k == key) {
                slot.1 = value;
            } else {
                v.push((key.to_string(), value));
            }
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Json> {
        if let Json::Obj(v) = self {
            if let Some(i) = v.iter().position(|(k, _)| k == key) {
                return Some(v.remove(i).1);
            }
        }
        None
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }

    /// Entier exact (sans partie décimale, dans l'intervalle sûr de f64).
    pub fn as_i64(&self) -> Option<i64> {
        let n = self.as_f64()?;
        if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
            Some(n as i64)
        } else {
            None
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        self.as_i64().and_then(|n| u64::try_from(n).ok())
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(v) => Some(v),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Obj(v) => Some(v),
            _ => None,
        }
    }

    // --- accès typés pratiques pour les arguments RPC ----------------------

    pub fn str_of(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Json::as_str)
    }

    pub fn bool_of(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(Json::as_bool)
    }

    pub fn u64_of(&self, key: &str) -> Option<u64> {
        self.get(key).and_then(Json::as_u64)
    }

    pub fn i64_of(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(Json::as_i64)
    }

    pub fn f64_of(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(Json::as_f64)
    }

    pub fn strings_of(&self, key: &str) -> Option<Vec<String>> {
        let arr = self.get(key)?.as_array()?;
        arr.iter().map(|v| v.as_str().map(str::to_string)).collect()
    }

    pub fn write_to(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Num(n) => write_num(out, *n),
            Json::Str(s) => write_str(out, s),
            Json::Arr(v) => {
                out.push('[');
                for (i, item) in v.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write_to(out);
                }
                out.push(']');
            }
            Json::Obj(v) => {
                out.push('{');
                for (i, (k, item)) in v.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(out, k);
                    out.push(':');
                    item.write_to(out);
                }
                out.push('}');
            }
        }
    }

    /// Écriture indentée (2 espaces), pour les fichiers lisibles par l'utilisateur.
    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.pretty_into(&mut out, 0);
        out.push('\n');
        out
    }

    fn pretty_into(&self, out: &mut String, indent: usize) {
        match self {
            Json::Arr(v) if !v.is_empty() => {
                let simple = v.iter().all(|x| !matches!(x, Json::Arr(_) | Json::Obj(_)));
                if simple {
                    self.write_to(out);
                    return;
                }
                out.push_str("[\n");
                for (i, item) in v.iter().enumerate() {
                    push_indent(out, indent + 1);
                    item.pretty_into(out, indent + 1);
                    if i + 1 < v.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                push_indent(out, indent);
                out.push(']');
            }
            Json::Obj(v) if !v.is_empty() => {
                out.push_str("{\n");
                for (i, (k, item)) in v.iter().enumerate() {
                    push_indent(out, indent + 1);
                    write_str(out, k);
                    out.push_str(": ");
                    item.pretty_into(out, indent + 1);
                    if i + 1 < v.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                push_indent(out, indent);
                out.push('}');
            }
            other => other.write_to(out),
        }
    }
}

fn push_indent(out: &mut String, n: usize) {
    for _ in 0..n {
        out.push_str("  ");
    }
}

impl fmt::Display for Json {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut s = String::new();
        self.write_to(&mut s);
        f.write_str(&s)
    }
}

fn write_num(out: &mut String, n: f64) {
    use fmt::Write;
    if !n.is_finite() {
        out.push_str("null");
    } else if n.fract() == 0.0 && n.abs() < 1e15 {
        let _ = write!(out, "{}", n as i64);
    } else {
        let _ = write!(out, "{}", n);
    }
}

/// Écrit une chaîne JSON entre guillemets. `<`, `>`, `&`, U+2028 et
/// U+2029 sont échappés pour que la sortie puisse être placée sans risque
/// dans un script JavaScript ou un document HTML.
pub fn write_str(out: &mut String, s: &str) {
    use fmt::Write;
    out.reserve(s.len() + 2);
    out.push('"');
    let mut start = 0;
    for (i, ch) in s.char_indices() {
        let esc: Option<&str> = match ch {
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            '\n' => Some("\\n"),
            '\r' => Some("\\r"),
            '\t' => Some("\\t"),
            '\u{08}' => Some("\\b"),
            '\u{0C}' => Some("\\f"),
            _ => None,
        };
        let needs_u = esc.is_none()
            && ((ch as u32) < 0x20
                || ch == '<'
                || ch == '>'
                || ch == '&'
                || ch == '\u{2028}'
                || ch == '\u{2029}');
        if esc.is_some() || needs_u {
            out.push_str(&s[start..i]);
            if let Some(e) = esc {
                out.push_str(e);
            } else {
                let _ = write!(out, "\\u{:04x}", ch as u32);
            }
            start = i + ch.len_utf8();
        }
    }
    out.push_str(&s[start..]);
    out.push('"');
}

pub fn quote(s: &str) -> String {
    let mut out = String::new();
    write_str(&mut out, s);
    out
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn err(&self, msg: &'static str) -> ParseError {
        ParseError { pos: self.i, msg }
    }

    fn ws(&mut self) {
        while let Some(&c) = self.s.get(self.i) {
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.i += 1;
            } else {
                break;
            }
        }
    }

    fn value(&mut self) -> Result<Json, ParseError> {
        match self.s.get(self.i) {
            None => Err(self.err("fin de texte inattendue")),
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.literal(b"true", Json::Bool(true)),
            Some(b'f') => self.literal(b"false", Json::Bool(false)),
            Some(b'n') => self.literal(b"null", Json::Null),
            Some(b'-') | Some(b'0'..=b'9') => self.number(),
            Some(_) => Err(self.err("caractère inattendu")),
        }
    }

    fn literal(&mut self, word: &[u8], v: Json) -> Result<Json, ParseError> {
        if self.s[self.i..].starts_with(word) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(self.err("littéral invalide"))
        }
    }

    fn enter(&mut self) -> Result<(), ParseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            Err(self.err("imbrication trop profonde"))
        } else {
            Ok(())
        }
    }

    fn object(&mut self) -> Result<Json, ParseError> {
        self.enter()?;
        self.i += 1; // {
        let mut items: Vec<(String, Json)> = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b'}') {
            self.i += 1;
            self.depth -= 1;
            return Ok(Json::Obj(items));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return Err(self.err("clé attendue"));
            }
            let key = self.string()?;
            self.ws();
            if self.s.get(self.i) != Some(&b':') {
                return Err(self.err("« : » attendu"));
            }
            self.i += 1;
            self.ws();
            let v = self.value()?;
            if let Some(slot) = items.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = v;
            } else {
                items.push((key, v));
            }
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    break;
                }
                _ => return Err(self.err("« , » ou « } » attendu")),
            }
        }
        self.depth -= 1;
        Ok(Json::Obj(items))
    }

    fn array(&mut self) -> Result<Json, ParseError> {
        self.enter()?;
        self.i += 1; // [
        let mut items = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b']') {
            self.i += 1;
            self.depth -= 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value()?);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    break;
                }
                _ => return Err(self.err("« , » ou « ] » attendu")),
            }
        }
        self.depth -= 1;
        Ok(Json::Arr(items))
    }

    fn hex4(&mut self) -> Result<u32, ParseError> {
        let h = self.s.get(self.i..self.i + 4).ok_or_else(|| self.err("échappement \\u incomplet"))?;
        let mut v = 0u32;
        for &c in h {
            let d = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err(self.err("échappement \\u invalide")),
            };
            v = v * 16 + d as u32;
        }
        self.i += 4;
        Ok(v)
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.i += 1; // "
        let mut out: Vec<u8> = Vec::new();
        loop {
            let start = self.i;
            while let Some(&c) = self.s.get(self.i) {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.i += 1;
            }
            out.extend_from_slice(&self.s[start..self.i]);
            match self.s.get(self.i) {
                None => return Err(self.err("chaîne non terminée")),
                Some(b'"') => {
                    self.i += 1;
                    break;
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = *self.s.get(self.i).ok_or_else(|| self.err("échappement incomplet"))?;
                    self.i += 1;
                    match c {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0C),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xD800..0xDC00).contains(&cp) {
                                // Paire de substitution attendue.
                                if self.s.get(self.i) == Some(&b'\\') && self.s.get(self.i + 1) == Some(&b'u') {
                                    let save = self.i;
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if (0xDC00..0xE000).contains(&lo) {
                                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                    } else {
                                        self.i = save;
                                        cp = 0xFFFD;
                                    }
                                } else {
                                    cp = 0xFFFD;
                                }
                            } else if (0xDC00..0xE000).contains(&cp) {
                                cp = 0xFFFD;
                            }
                            let ch = char::from_u32(cp).unwrap_or('\u{FFFD}');
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => return Err(self.err("échappement inconnu")),
                    }
                }
                Some(_) => return Err(self.err("caractère de contrôle dans une chaîne")),
            }
        }
        // Le texte source est de l'UTF-8 valide et les échappements produisent
        // de l'UTF-8 valide : la conversion ne peut pas échouer.
        String::from_utf8(out).map_err(|_| self.err("UTF-8 invalide"))
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.i;
        if self.s.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
            }
            _ => return Err(self.err("nombre invalide")),
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            if !matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
                return Err(self.err("nombre invalide"));
            }
            while matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
                self.i += 1;
            }
        }
        if matches!(self.s.get(self.i), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            if !matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
                return Err(self.err("exposant invalide"));
            }
            while matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
                self.i += 1;
            }
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).map_err(|_| self.err("nombre invalide"))?;
        text.parse::<f64>().map(Json::Num).map_err(|_| self.err("nombre invalide"))
    }
}

// --- conversions -------------------------------------------------------------

impl From<bool> for Json {
    fn from(v: bool) -> Self {
        Json::Bool(v)
    }
}
impl From<&str> for Json {
    fn from(v: &str) -> Self {
        Json::Str(v.to_string())
    }
}
impl From<String> for Json {
    fn from(v: String) -> Self {
        Json::Str(v)
    }
}
impl From<&String> for Json {
    fn from(v: &String) -> Self {
        Json::Str(v.clone())
    }
}
impl From<f64> for Json {
    fn from(v: f64) -> Self {
        Json::Num(v)
    }
}
macro_rules! from_int {
    ($($t:ty),*) => {$(
        impl From<$t> for Json {
            fn from(v: $t) -> Self { Json::Num(v as f64) }
        }
    )*};
}
from_int!(i32, i64, u32, u64, usize, u8, u16, i128);

impl From<Vec<Json>> for Json {
    fn from(v: Vec<Json>) -> Self {
        Json::Arr(v)
    }
}
impl<T: Into<Json>> From<Option<T>> for Json {
    fn from(v: Option<T>) -> Self {
        match v {
            Some(x) => x.into(),
            None => Json::Null,
        }
    }
}
impl From<Vec<String>> for Json {
    fn from(v: Vec<String>) -> Self {
        Json::Arr(v.into_iter().map(Json::Str).collect())
    }
}

/// Construction fluide d'objets : `Obj::new().put("a", 1).build()`.
#[derive(Default)]
pub struct Obj(Vec<(String, Json)>);

impl Obj {
    pub fn new() -> Self {
        Obj(Vec::new())
    }
    pub fn put(mut self, key: &str, value: impl Into<Json>) -> Self {
        self.0.push((key.to_string(), value.into()));
        self
    }
    pub fn put_if(self, cond: bool, key: &str, value: impl Into<Json>) -> Self {
        if cond {
            self.put(key, value)
        } else {
            self
        }
    }
    pub fn build(self) -> Json {
        Json::Obj(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic_values() {
        assert_eq!(Json::parse("null").unwrap(), Json::Null);
        assert_eq!(Json::parse(" true ").unwrap(), Json::Bool(true));
        assert_eq!(Json::parse("-12.5e2").unwrap(), Json::Num(-1250.0));
        assert_eq!(Json::parse("0").unwrap(), Json::Num(0.0));
        assert_eq!(Json::parse("\"a\\nb\"").unwrap(), Json::Str("a\nb".into()));
        let v = Json::parse(r#"{"a":[1,2,{"b":null}],"c":"d"}"#).unwrap();
        assert_eq!(v.get("c").unwrap().as_str(), Some("d"));
        assert_eq!(v.get("a").unwrap().as_array().unwrap().len(), 3);
    }

    #[test]
    fn rejects_invalid() {
        for bad in ["", "{", "[1,]", "{\"a\" 1}", "01", "1.", "-", "\"\u{0001}\"", "tru", "[1] x", "{'a':1}", "1e", "\"\\x\""] {
            assert!(Json::parse(bad).is_err(), "devrait échouer : {bad:?}");
        }
    }

    #[test]
    fn depth_is_bounded() {
        let deep = "[".repeat(MAX_DEPTH + 5) + &"]".repeat(MAX_DEPTH + 5);
        assert!(Json::parse(&deep).is_err());
        let ok = "[".repeat(50) + &"]".repeat(50);
        assert!(Json::parse(&ok).is_ok());
    }

    #[test]
    fn unicode_escapes_and_surrogates() {
        assert_eq!(Json::parse(r#""\u00e9\ud83d\ude00""#).unwrap(), Json::Str("é😀".into()));
        // Substitut isolé : remplacé, pas d'erreur.
        assert_eq!(Json::parse(r#""\ud83d x""#).unwrap(), Json::Str("\u{FFFD} x".into()));
        assert_eq!(Json::parse(r#""\udc00""#).unwrap(), Json::Str("\u{FFFD}".into()));
    }

    #[test]
    fn duplicate_keys_last_wins() {
        let v = Json::parse(r#"{"a":1,"a":2}"#).unwrap();
        assert_eq!(v.get("a").unwrap().as_i64(), Some(2));
        assert_eq!(v.as_object().unwrap().len(), 1);
    }

    #[test]
    fn write_roundtrip_and_escaping() {
        let v = Obj::new()
            .put("t", "ligne1\nligne2\t\"q\" \\ </script> \u{2028}")
            .put("n", 42u64)
            .put("f", 1.5)
            .put("e", Json::Null)
            .put("arr", vec![Json::Bool(false), Json::from("x")])
            .build();
        let s = v.to_string();
        assert!(!s.contains("</script>"));
        assert!(!s.contains('\u{2028}'));
        assert_eq!(Json::parse(&s).unwrap(), v);
        assert_eq!(Json::parse(&v.to_pretty()).unwrap(), v);
    }

    #[test]
    fn numbers_format() {
        assert_eq!(Json::from(3u64).to_string(), "3");
        assert_eq!(Json::from(-0.25).to_string(), "-0.25");
        assert_eq!(Json::Num(f64::NAN).to_string(), "null");
        assert_eq!(Json::from(1_700_000_000_123u64).to_string(), "1700000000123");
    }

    #[test]
    fn accessors() {
        let v = Json::parse(r#"{"s":"x","b":true,"n":7,"f":7.5,"l":["a","b"],"neg":-1}"#).unwrap();
        assert_eq!(v.str_of("s"), Some("x"));
        assert_eq!(v.bool_of("b"), Some(true));
        assert_eq!(v.u64_of("n"), Some(7));
        assert_eq!(v.u64_of("f"), None);
        assert_eq!(v.u64_of("neg"), None);
        assert_eq!(v.i64_of("neg"), Some(-1));
        assert_eq!(v.strings_of("l"), Some(vec!["a".to_string(), "b".to_string()]));
        let mut m = v.clone();
        m.set("s", "y");
        m.set("new", 1u32);
        assert_eq!(m.str_of("s"), Some("y"));
        assert_eq!(m.u64_of("new"), Some(1));
        assert!(m.remove("new").is_some());
        assert!(m.get("new").is_none());
    }

    #[test]
    fn bom_is_ignored() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(b"{\"a\":1}");
        assert!(Json::parse_bytes(&b).is_ok());
        assert!(Json::parse_bytes(&[0xFF, 0xFE]).is_err());
    }
}
