//! Standard base64 decoding, for payloads in `render`'s calls file. Twenty
//! lines rather than a dependency.

pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    let value = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in text.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        acc = (acc << 6)
            | value(c).ok_or_else(|| format!("invalid base64 character {:?}", c as char))?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes() {
        assert_eq!(super::decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(super::decode("AACAPw==").unwrap(), 1.0f32.to_le_bytes());
    }
}
