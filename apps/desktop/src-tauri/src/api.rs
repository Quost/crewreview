//! A small HTTP client for the crew's local API. It only ever talks to 127.0.0.1, so it needs no TLS and no crates.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::Value;

/// Where the crew listens, as `run --desktop` reported it.
#[derive(Clone, Debug, PartialEq)]
pub struct Conn {
    pub url: String,
    pub port: u16,
    pub token: String,
    pub version: String,
    /// Started by this app (it stops with it), or a crew that was already running (the background service).
    pub managed: bool,
}

impl Conn {
    pub fn from_info(info: &Value, managed: bool) -> Option<Conn> {
        Some(Conn {
            url: info.get("url")?.as_str()?.to_string(),
            port: u16::try_from(info.get("port")?.as_u64()?).ok()?,
            token: info.get("token")?.as_str()?.to_string(),
            version: info.get("version").and_then(Value::as_str).unwrap_or("?").to_string(),
            managed,
        })
    }

    /// The dashboard address. The token rides in the fragment, which the page reads once and a server never sees.
    pub fn dashboard(&self, page: Option<&str>) -> String {
        match page {
            Some(page) => format!("{}#/{page}&token={}", self.url, self.token),
            None => format!("{}#token={}", self.url, self.token),
        }
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        self.request("GET", path)
    }

    pub fn post(&self, path: &str) -> Result<Value, String> {
        self.request("POST", path)
    }

    fn request(&self, method: &str, path: &str) -> Result<Value, String> {
        let addr = SocketAddr::from(([127, 0, 0, 1], self.port));
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
        stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
        // Writes need the x-crewreview header (the API's guard against cross-site posts).
        let extra = if method == "GET" { "" } else { "x-crewreview: 1\r\nContent-Length: 0\r\n" };
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n{extra}Connection: close\r\n\r\n",
            port = self.port,
            token = self.token,
        );
        stream.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
        parse_response(&raw)
    }
}

/// The JSON body of a 200 response, plain or chunked.
pub fn parse_response(raw: &[u8]) -> Result<Value, String> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("response without headers")?;
    let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or("response without a status")?;
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    let body = &raw[end + 4..];
    let chunked = head
        .lines()
        .any(|line| line.starts_with("transfer-encoding:") && line.contains("chunked"));
    let body = if chunked { dechunk(body)? } else { body.to_vec() };
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

fn dechunk(mut rest: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n").ok_or("bad chunk")?;
        let size_text = std::str::from_utf8(&rest[..line_end]).map_err(|e| e.to_string())?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).map_err(|e| e.to_string())?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if rest.len() < size + 2 {
            return Err("short chunk".into());
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_and_chunked_bodies() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"inbox\": 2 }";
        assert_eq!(parse_response(plain).unwrap()["inbox"], 2);
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n3\r\n 1}\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).unwrap()["a"], 1);
    }

    #[test]
    fn errors_are_errors() {
        assert_eq!(parse_response(b"HTTP/1.1 401 Unauthorized\r\n\r\n{}").unwrap_err(), "HTTP 401");
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn dashboard_links_carry_the_token_in_the_fragment() {
        let info = serde_json::json!({ "url": "http://127.0.0.1:4100/", "port": 4100, "token": "abc", "pid": 1, "version": "0.3.0" });
        let conn = Conn::from_info(&info, true).unwrap();
        assert_eq!(conn.dashboard(None), "http://127.0.0.1:4100/#token=abc");
        assert_eq!(conn.dashboard(Some("inbox")), "http://127.0.0.1:4100/#/inbox&token=abc");
        assert!(Conn::from_info(&serde_json::json!({ "url": "x" }), true).is_none());
    }
}
